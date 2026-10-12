/* Shared checks that evidence and output directories resolve outside the repository, including symlink targets. */
const fs=require('node:fs'),path=require('node:path');
// Resolve the nearest existing ancestor through realpath, then re-append the parts that do not exist yet.
function canonicalPath(value){
  if(!value||!path.isAbsolute(value))throw Error('Artifact directory must be absolute.');
  let existing=path.resolve(value);
  const missing=[];
  while(!fs.existsSync(existing)){
    const ancestor=path.dirname(existing);
    if(ancestor===existing)throw Error('Artifact directory has no accessible filesystem root.');
    missing.unshift(path.basename(existing));existing=ancestor;
  }
  if(!fs.statSync(existing).isDirectory())throw Error('Artifact directory ancestor is not a directory: '+existing);
  return path.join(fs.realpathSync(existing),...missing);
}
function isWithin(root,candidate){
  const relative=path.relative(root,candidate);
  return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
}
module.exports={canonicalPath,isWithin};
