export const clamp=(v,l,h)=>Math.max(l,Math.min(h,v));
export function poissonPmf(k,lambda){if(lambda<=0)return 0;let f=1;for(let i=2;i<=k;i+=1)f*=i;return Math.exp(-lambda)*(lambda**k)/f;}
function erf(x){const s=x<0?-1:1,a=Math.abs(x),t=1/(1+0.3275911*a);return s*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-a*a));}
export function normalCdf(x,mean=0,std=1){return std<=0?0.5:0.5*(1+erf((x-mean)/(std*Math.sqrt(2))));}
export function normalizedImpliedProbabilities(odds){const raw={};for(const[k,v]of Object.entries(odds))if(typeof v==='number'&&v>1)raw[k]=1/v;const total=Object.values(raw).reduce((s,v)=>s+v,0);return total?Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v/total])):{};}
export const valueBet=(modelProb,marketProb)=>(modelProb-marketProb)*100;
export const recommendation=valuePct=>valuePct>0?'SÁZET':'NEVÁHAT';
export function scoreMatrix(homeLambda,awayLambda,maxScore=10){let homeWin=0,draw=0,awayWin=0,bestProb=-1,bestScore=[0,0];for(let hg=0;hg<=maxScore;hg+=1){const ph=poissonPmf(hg,homeLambda);for(let ag=0;ag<=maxScore;ag+=1){const p=ph*poissonPmf(ag,awayLambda);if(hg>ag)homeWin+=p;else if(hg===ag)draw+=p;else awayWin+=p;if(p>bestProb){bestProb=p;bestScore=[hg,ag];}}}const total=homeWin+draw+awayWin;return[homeWin/total,draw/total,awayWin/total,bestScore];}
export const round=(value,digits=1)=>Number(value.toFixed(digits));
