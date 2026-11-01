// Validates the benchmark: oracle passes on correct code, and catches every held-out bug.
import fs from "node:fs"; import path from "node:path"; import {spawnSync} from "node:child_process"; import tasks from "./tasks.mjs";
const root="/tmp/wk"; const deps=root+"/_deps"; fs.mkdirSync(deps,{recursive:true});
if(!fs.existsSync(deps+"/node_modules/vitest")){fs.writeFileSync(deps+"/package.json",'{"name":"d","private":true}');spawnSync("npm",["i","--silent","vitest@5.0.5","typescript@5.9.3"],{cwd:deps,stdio:"inherit"});}
const run=(dir)=>{const r=spawnSync(deps+"/node_modules/.bin/vitest",["run","--reporter=dot"],{cwd:dir,encoding:"utf8",env:{...process.env,CI:"1",NO_COLOR:"1"}});return r.status===0};
const dir=root+"/_validate";let bad=0,total=0;
const apply=(s,[a,b],label)=>{const n=s.split(a).length-1;if(n!==1){console.log("PATCH COUNT",label,JSON.stringify(a),n);bad++}return s.replace(a,()=>b)};
for(const [name,t] of Object.entries(tasks)){
 fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir+"/src",{recursive:true});fs.mkdirSync(dir+"/test");fs.symlinkSync(deps+"/node_modules",dir+"/node_modules");
 fs.writeFileSync(dir+"/test/o.test.ts",t.oracle);const f=`${dir}/src/${t.file}.ts`;
 const good=t.seeded?t.ref.reduce((s,p)=>apply(s,p,name+" ref"),t.src):t.src;
 fs.writeFileSync(f,good);if(!run(dir)){console.log("ORACLE FAILS CLEAN",name);bad++}
 if(t.seeded){fs.writeFileSync(f,t.src);if(run(dir)){console.log("SEEDED NOT DETECTED",name);bad++}}
 for(const [label,a,b] of t.bugs){total++;fs.writeFileSync(f,apply(good,[a,b],name+"/"+label));if(run(dir)){console.log("BUG NOT CAUGHT BY ORACLE",name,label);bad++}}
 console.log("ok",name,t.bugs.length);
}
fs.rmSync(dir,{recursive:true,force:true});console.log({totalBugs:total,bad});
