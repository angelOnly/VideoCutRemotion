export function searchLibrary(root:string,request?:Record<string,unknown>):Record<string,unknown>;
export interface LibraryMechanism { id:string; search_text:string; text_sha256:string; search_text_version:string; [key:string]:unknown }
export interface LibraryIndex { source_sha256:string; mechanisms:LibraryMechanism[]; count:number; [key:string]:unknown }
export function loadLibraryIndex(root:string):LibraryIndex;
export function searchLibraryIndex(index:LibraryIndex,request?:Record<string,unknown>,semantic?:Record<string,unknown>):Record<string,unknown>;
export function libraryVideo(root:string,id:string,source_sha256?:string):string;
export function readLibraryMechanism(root:string,request:{id:string;part?:'mechanism'|'overview';source_sha256?:string;include_storyboard?:boolean}):{result:Record<string,unknown>;image?:string};
