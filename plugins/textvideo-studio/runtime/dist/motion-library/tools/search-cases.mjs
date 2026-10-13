import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {searchCases, facets} from '../search.mjs';

const catalogue = JSON.parse(readFileSync(new URL('../case-catalogue.json', import.meta.url),'utf8'));
const args = process.argv.slice(2), options={filters:{},query:'',limit:5};
for(let i=0;i<args.length;i++) {
  const key=args[i].replace(/^--/,'');
  if(!['query','limit',...Object.keys(facets)].includes(key) || i+1>=args.length) throw new Error('参数必须为 --query 文本、--limit 数量或分类字段和值');
  const value=args[++i];
  if(key==='query') options.query=value;
  else if(key==='limit') {options.limit=Number(value); if(!Number.isInteger(options.limit)||options.limit<1) throw new Error('limit 必须为正整数');}
  else options.filters[key]=value;
}
const matches=searchCases(catalogue.cases,options).map(c=>({...c,
  local_directory:fileURLToPath(new URL('../'+c.directory+'/',import.meta.url)),
  preview_url:'http://127.0.0.1:8874/library/'+c.detail,
}));
console.log(JSON.stringify({count:matches.length,notice: matches.length ? '用途是迁移建议；materials 才是原片实见。阅读入围拆解再采用。':'没有直接匹配；可显式放宽一个条件寻找可迁移方法，不冒充直接匹配。',cases:matches},null,2));
