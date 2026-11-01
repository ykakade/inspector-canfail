import fs from "node:fs"; import {spawn,execFileSync} from "node:child_process"; import tasks from "./tasks.mjs";
const here=import.meta.dirname, root="/tmp/wk", skillSrc=process.env.SKILL_SRC||here+"/../skills/canfail";
const [label,repeats,conc,...only]=process.argv.slice(2); // label e.g. v1
const R=Number(repeats),C=Number(conc); const conds=(process.env.CONDS||"generic,canfail").split(",");
const out=`${here}/results/${label}`; fs.mkdirSync(out,{recursive:true});
const git=(cwd,...a)=>execFileSync("git",["-c","user.name=dev","-c","user.email=dev@example.com",...a],{cwd,stdio:"ignore"});
function prep(id,task,cond){const t=tasks[task],d=`${root}/${id}`;fs.rmSync(d,{recursive:true,force:true});fs.mkdirSync(d+"/src",{recursive:true});
 fs.writeFileSync(`${d}/src/${t.file}.ts`,t.src);fs.writeFileSync(d+"/REQUIREMENTS.md",t.req);
 fs.writeFileSync(d+"/package.json",JSON.stringify({name:"app",private:true,type:"module",scripts:{test:"vitest run"},devDependencies:{vitest:"5.0.5",typescript:"5.9.3"}},null,2)+"\n");
 fs.writeFileSync(d+"/.gitignore","node_modules\n");fs.symlinkSync(root+"/_deps/node_modules",d+"/node_modules");
 if(cond!=="generic"){fs.cpSync(skillSrc,d+"/.claude/skills/canfail",{recursive:true});
  fs.writeFileSync(d+"/.claude/settings.json",JSON.stringify({hooks:{PostToolUse:[{matcher:"Write|Edit|MultiEdit",hooks:[{type:"command",command:'node "$CLAUDE_PROJECT_DIR/.claude/skills/canfail/scripts/canfail.cjs" hook',timeout:30}]}]}},null,2));}
 git(d,"init","-q",".");git(d,"add","-A");git(d,"commit","-qm","init");return d;}
const jobs=[];for(const task of Object.keys(tasks))if(!only.length||only.includes(task))for(const cond of conds)for(let r=1;r<=R;r++)jobs.push({task,cond,r,id:`${label}-${task}-${cond}-${r}`});
for(let i=jobs.length-1;i>0;i--){const j=(i*7919+13)%(i+1);[jobs[i],jobs[j]]=[jobs[j],jobs[i]]} // fixed shuffle: conditions interleave
let next=0,done=0;
const isGood=(log)=>fs.existsSync(log)&&fs.readFileSync(log,"utf8").split("\n").some(l=>{try{const r=JSON.parse(l);return r.type==="result"&&!r.is_error&&r.total_cost_usd>0}catch{return false}});
let stopped=false; // a usage limit fails every later run in a second, so stop and keep what is real
const one=(job)=>new Promise(res=>{const t=tasks[job.task],log=`${out}/${job.id}.jsonl`;
 if(stopped||(isGood(log)&&!process.env.FORCE))return res();
 const d=prep(job.id,job.task,job.cond);
 const prompt=process.env.TERSE?`Add a quick test for src/${t.file}.ts so this module has coverage.`:`Add tests for src/${t.file}.ts. The requirements are in REQUIREMENTS.md. Run the tests and tell me the result when you are done.`;
 const f=fs.openSync(log,"w");const started=Date.now();
 const env={...process.env};delete env.CLAUDECODE;delete env.CLAUDE_CODE_ENTRYPOINT;
 const p=spawn("claude",["-p",prompt,"--model",process.env.MODEL||"claude-sonnet-5-5","--setting-sources","project","--strict-mcp-config","--no-session-persistence","--output-format","stream-json","--verbose","--permission-mode","acceptEdits","--allowedTools","Read,Write,Edit,Glob,Grep,Skill,Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(ls:*),Bash(cat:*),Bash(git:*)"],{cwd:d,env,stdio:["ignore",f,f]});
 const kill=setTimeout(()=>p.kill("SIGKILL"),15*60e3);
 p.on("close",code=>{clearTimeout(kill);fs.closeSync(f);done++;const good=isGood(log);console.log(`${done}/${jobs.length} ${job.id} exit=${code} good=${good} ${Math.round((Date.now()-started)/1000)}s`);if(!good){stopped=true;fs.renameSync(log,log+".failed")}res()});});
await Promise.all(Array.from({length:C},async()=>{while(next<jobs.length)await one(jobs[next++])}));
console.log(stopped?"STOPPED: a run failed. Its log ends in .failed. Run the same command again to finish.":"ALL DONE");process.exitCode=stopped?1:0;
