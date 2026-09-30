'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
function ignored(name){
 return name==='phase7-release.json'||/(^|\/)(node_modules|dist|\.git|__pycache__|\.cache)(\/|$)/.test(name)
  ||/^(userData|userdata|sessions?|storage|backups?|cache|logs|data)(\/|$)/i.test(name)
  ||/^apps\/desktop\/(userData|userdata|sessions?|storage|backups?|cache|logs|data)(\/|$)/i.test(name)
  ||/(^|\/)\.env(?:\..*)?$/.test(name)||/\.(log|tsbuildinfo|pyc)$/.test(name)||/(^|\/)\.DS_Store$/.test(name);
}
async function sourcePaths(root){
 const result=[];let seen=0;
 async function walk(rel=''){
  for(const entry of await fs.readdir(path.join(root,rel),{withFileTypes:true})){
   if(++seen>30000)throw Error('PHASE7_SOURCE_INVENTORY_LIMIT');
   const name=rel?rel+'/'+entry.name:entry.name;if(ignored(name))continue;
   if(entry.isSymbolicLink())throw Error('PHASE7_SOURCE_SYMLINK:'+name);
   if(entry.isDirectory())await walk(name);else if(entry.isFile())result.push(name);else throw Error('PHASE7_SOURCE_SPECIAL_FILE:'+name);
  }
 }await walk();return result.sort();
}
module.exports={ignored,sourcePaths};
