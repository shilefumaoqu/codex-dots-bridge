import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const packages = [];
const supplemental = JSON.parse(readFileSync('licenses/supplemental.json','utf8'));
function visitModules(modules) {
  if (!existsSync(modules)) return;
  for (const name of readdirSync(modules)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const child of readdirSync(join(modules,name))) visitPackage(join(modules,name,child));
    } else visitPackage(join(modules,name));
  }
}
function visitPackage(path) {
  const manifest = join(path,'package.json');
  if (!existsSync(manifest)) return;
  const pkg = JSON.parse(readFileSync(manifest,'utf8'));
  const notices = readdirSync(path).filter(name=>/^(?:licen[sc]e|copying|copyright|notice)(?:[.-]|$)/i.test(name)).map(name=>relative(root,join(path,name)).replaceAll('\\','/'));
  const extra = supplemental.find(item=>item.name===pkg.name&&item.version===pkg.version);
  if(extra) { if(!existsSync(extra.path))throw new Error(`Supplemental notice missing: ${pkg.name}`);notices.push(extra.path); }
  if (notices.length === 0 || !pkg.license) throw new Error(`Missing license declaration/text: ${pkg.name}`);
  packages.push({name:pkg.name,version:pkg.version,license:pkg.license,path:relative(root,path).replaceAll('\\','/'),notices,...(extra?{supplementalSource:extra.source}: {})});
  visitModules(join(path,'node_modules'));
}
visitModules(join(root,'node_modules'));
packages.sort((a,b)=>a.name.localeCompare(b.name));
mkdirSync('licenses',{recursive:true});
writeFileSync('licenses/npm-inventory.json', JSON.stringify({schema:1,packages},null,2)+'\n');
console.log(`Verified ${packages.length} bundled npm package license declarations and notice files`);
