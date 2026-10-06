declare module 'node:sqlite' {
 export class DatabaseSync {
  constructor(path:string);
  exec(sql:string):void;
  prepare(sql:string):{run(...args:unknown[]):unknown;get(...args:unknown[]):Record<string,unknown>|undefined;all(...args:unknown[]):Record<string,unknown>[]};
 }
}
