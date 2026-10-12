export const taxonomy:Record<string,string[][]>;
export const retrievalFields:string[];
export function termsFor(field:string):string[];
export function validateRetrieval(value:unknown,id?:string):unknown;
