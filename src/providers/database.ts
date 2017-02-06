import * as _ from 'lodash';
import { apps } from '../apps';
import {Event, RawEvent} from '../event';
import {CloudFunction, makeCloudFunction} from './base';
import {normalizePath, applyChange, pathParts, valAt, joinPath} from '../utils';
import * as firebase from 'firebase-admin';

/** @internal */
export const provider = 'google.firebase.database';

/**
 * Handle events at a Firebase Realtime Database ref.
 *
 * The database.ref() functions behave very similarly to the normal Firebase
 * SDKs. Any change to the database that affects the data at or below ref will
 * fire an event in Cloud Functions.
 *
 * There are three important differences between listening to a database event
 * in Cloud Functions and using the Realtime Database SDK:
 * 1. The Cloud Functions SDK allows wildcards in the ref name. Any path
 *    component in curly brackets ({}) will match any value. The actual value
 *    that matched will be returned in eventnt.params. E.g. ref('foo/{bar}') will
 *    match a change at 'foo/baz' and the event will have params {bar: 'baz'}.
 * 2. Unlike the Realtime Database SDK, Cloud Functions will not fire an event
 *    for data that already existed before the Cloud Function was deployed.
 * 3. Cloud Function events have access to more information than the normal
 *    SDK. E.g. the snapshot passed to a Cloud Function has access to the
 *    previous event data as well as the user who triggered the change.
 */
export function ref(ref: string): RefBuilder {
  let normalized = normalizePath(ref);
  let resource = `projects/_/instances/${process.env.DB_NAMESPACE}/refs/${normalized}`;
  return new RefBuilder(apps(), resource);
}

/** Builder used to create Cloud Functions for Firebase Realtime Database References. */
export class RefBuilder {
  /** @internal */
  constructor(private apps: apps.Apps, private resource) {}

  /** Respond to any write that affects a ref. */
  onWrite(handler: (event: Event<DeltaSnapshot>) => PromiseLike<any> | any): CloudFunction {
    return makeCloudFunction({
      provider, handler,
      eventType: 'ref.write',
      resource: this.resource,
      dataConstructor: (raw) => new DeltaSnapshot(this.apps, raw),
      before: (payload) => this.apps.retain(payload),
      after: (payload) => this.apps.release(payload),
    });
  }
}

export class DeltaSnapshot implements firebase.database.DataSnapshot {
  private _adminRef: firebase.database.Reference;
  private _apps: apps.Apps;
  private _ref: firebase.database.Reference;
  private _path: string;
  private _data: any;
  private _delta: any;
  private _newData: any;
  private _auth: apps.AuthMode;

  private _childPath: string;
  private _isPrevious: boolean;

  constructor(apps: apps.Apps, event: RawEvent) {
    this._apps = apps;

    if (event) {
      let resourceRegex = `projects/([^/]+)/instances/([^/]+)/refs(/.+)?`;
      let match = event.resource.match(new RegExp(resourceRegex));
      if (!match) {
        throw new Error(`Unexpected resource string for Firebase Realtime Database event: ${event.resource}. ` +
          'Expected string in the format of "projects/_/instances/{firebaseioSubdomain}/refs/{ref=**}"');
      }
      let [, project, /* instance */ , ref] = match;
      if (project !== '_') {
        throw new Error(`Expect project to be '_' in a Firebase Realtime Database event`);
      }

      this._path = normalizePath(ref);
      this._auth = event.auth;
      this._data = event.data.data;
      this._delta = event.data.delta;
      this._newData = applyChange(this._data, this._delta);
    }
  }

  get ref(): firebase.database.Reference {
    if (!this._ref) {
      this._ref = this._apps.forMode(this._auth).database().ref(this._fullPath());
    }
    return this._ref;
  }

  get adminRef(): firebase.database.Reference {
    if (!this._adminRef) {
      this._adminRef = this._apps.admin.database().ref(this._fullPath());
    }
    return this._adminRef;
  }

  get key(): string {
    let last = _.last(pathParts(this._fullPath()));
    return (!last || last === '') ? null : last;
  }

  val(): any {
    let parts = pathParts(this._childPath);
    let source = this._isPrevious ? this._data : this._newData;
    let node = _.cloneDeep(parts.length ? _.get(source, parts, null) : source);
    return this._checkAndConvertToArray(node);
  }

  // TODO(inlined): figure out what to do here
  exportVal(): any { return this.val(); }

  // TODO(inlined): figure out what to do here
  getPriority(): any {
    return 0;
  }

  exists(): boolean {
    return !_.isNull(this.val());
  }

  child(childPath?: string): DeltaSnapshot {
    if (!childPath) {
      return this;
    }
    return this._dup(this._isPrevious, childPath);
  }

  get previous(): DeltaSnapshot {
    return this._isPrevious ? this : this._dup(true);
  }

  get current(): DeltaSnapshot {
    return this._isPrevious ? this._dup(false) : this;
  }

  changed(): boolean {
    return valAt(this._delta, this._childPath) !== undefined;
  }

  // TODO(inlined) what is this boolean for?
  forEach(action: (a: DeltaSnapshot) => boolean): boolean {
    let val = this.val();
    if (_.isPlainObject(val)) {
      _.keys(val).forEach(key => action(this.child(key)));
    }
    return false;
  }

  hasChild(childPath: string): boolean {
    return this.child(childPath).exists();
  }

  hasChildren(): boolean {
    let val = this.val();
    return _.isPlainObject(val) && _.keys(val).length > 0;
  }

  numChildren(): number {
    let val = this.val();
    return _.isPlainObject(val) ? Object.keys(val).length : 0;
  }

  /* Recursive function to check if keys are numeric & convert node object to array if they are */
  private _checkAndConvertToArray(node): any {
    if (node === null || typeof node === 'undefined') {
      return null;
    }
    if (typeof node !== 'object') {
      return node;
    }
    let obj = {};
    let numKeys = 0;
    let maxKey = 0;
    let allIntegerKeys = true;
    _.forEach(node, (childNode, key) => {
      obj[key] = this._checkAndConvertToArray(childNode);
      numKeys++;
      const integerRegExp = /^(0|[1-9]\d*)$/;
      if (allIntegerKeys && integerRegExp.test(key)) {
        maxKey = Math.max(maxKey, Number(key));
      } else {
        allIntegerKeys = false;
      }
    });

    if (allIntegerKeys && maxKey < 2 * numKeys) {
      // convert to array.
      let array = [];
      _.forOwn(obj, (val, key) => {
        array[key] = val;
      });

      return array;
    }
    return obj;
  }

  private _dup(previous: boolean, childPath?: string): DeltaSnapshot {
    let dup = new DeltaSnapshot(this._apps, null);
    [dup._path, dup._auth, dup._data, dup._delta, dup._childPath, dup._newData] =
      [this._path, this._auth, this._data, this._delta, this._childPath, this._newData];

    if (previous) {
      dup._isPrevious = true;
    }

    if (childPath) {
      dup._childPath = joinPath(dup._childPath, childPath);
    }

    return dup;
  }

  private _fullPath(): string {
    let out = (this._path || '') + (this._childPath || '');
    if (out === '') {
      out = '/';
    }
    return out;
  }
}
