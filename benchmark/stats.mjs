import fs from "node:fs";import tasks from "./tasks.mjs";
const load=l=>JSON.parse(fs.readFileSync(`${import.meta.dirname}/results/${l}.json`));
let seed=42;const rnd=()=>(seed=(seed*1664525+1013904223)>>>0)/4294967296;
function strat(rs){const clean=rs.filter(r=>!tasks[r.task].seeded);const diff=a=>{const g=a.filter(x=>x.c==="generic"),c=a.filter(x=>x.c==="canfail");return c.reduce((n,x)=>n+x.v,0)/c.length-g.reduce((n,x)=>n+x.v,0)/g.length};
 const rows=clean.map(r=>({t:r.task,c:r.cond,v:r.caught.length/r.totalBugs}));const obs=diff(rows);let ge=0;const N=200000;const by={};rows.forEach(r=>(by[r.t]??=[]).push(r));
 for(let i=0;i<N;i++){const p=[];for(const a of Object.values(by)){const lab=a.map(x=>x.c);for(let j=lab.length-1;j>0;j--){const k=Math.floor(rnd()*(j+1));[lab[j],lab[k]]=[lab[k],lab[j]]}a.forEach((x,j)=>p.push({c:lab[j],v:x.v}))}if(Math.abs(diff(p))>=Math.abs(obs)-1e-12)ge++}
 return{diffPts:+(obs*100).toFixed(1),p:+(ge/N).toFixed(4)}}
const C=(n,k)=>{let r=1;for(let i=0;i<k;i++)r=r*(n-i)/(i+1);return r};
const fisher=(a,b,c,d)=>{const n=a+b+c+d,r=a+b,k=a+c,P=x=>C(r,x)*C(n-r,k-x)/C(n,k),o=P(a);let s=0;for(let x=Math.max(0,k-(n-r));x<=Math.min(r,k);x++)if(P(x)<=o+1e-12)s+=P(x);return +s.toFixed(3)};
const seen={};for(const l of ["v1","x2s","x2h"]){const r=load(l);console.log(l,strat(r));seen[l]=r}
const sf=l=>["generic","canfail"].map(c=>seen[l].filter(r=>tasks[r.task].seeded&&r.cond===c&&r.foundSeeded).length);
const [g1,c1]=sf("x2s"),[g2,c2]=sf("x2h");console.log("seeded found terse pooled generic",g1+g2,"/12 canfail",c1+c2,"/12 fisher p",fisher(g1+g2,12-g1-g2,c1+c2,12-c1-c2));
