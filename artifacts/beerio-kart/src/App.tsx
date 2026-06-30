import { useState, useCallback, useEffect, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";

// ─── Types ────────────────────────────────────────────────────────────────────

type SlotSeed  = { t: "seed"; n: number };
type SlotWin   = { t: "win";  m: string };
type SlotLose  = { t: "lose"; m: string };
type SlotSource = SlotSeed | SlotWin | SlotLose;

interface MatchDef {
  id: string; grp: string; bracket: "wb" | "lb" | "gf";
  drop?: string; a: SlotSource; b: SlotSource;
}
interface BracketGroup {
  key: string; title: string; bracket: "wb" | "lb" | "gf"; ids: string[];
}
interface Bracket {
  defs: MatchDef[]; byId: Record<string, MatchDef>;
  groups: BracketGroup[]; k: number; S: number;
}
interface Player { seed: number; name: string | null; }
const TBD: unique symbol = Symbol("TBD");
const BYE: { bye: true; name: "BYE"; seed?: undefined } = { bye: true, name: "BYE" };
type Competitor = Player | typeof TBD | typeof BYE;
interface MatchResult {
  a: Competitor; b: Competitor; winner: Competitor; loser: Competitor;
  decided: boolean; winSlot: "A" | "B" | null; auto: boolean;
  phantom: boolean; active: boolean; def: MatchDef;
}

// Race wins needed to take a match: 1 = single race, 2 = Best of 3, 3 = Best of 5
type SeriesLen = 1 | 2 | 3;
type Mode = "bracket" | "gp";        // bracket = 1v1 double-elim; gp = 4-kart Grand Prix
interface Format { series: SeriesLen; mode: Mode; gpRaces: number; }
type Series = Record<string, { a: number; b: number }>;
interface SavedState {
  playerCount: number; names: string[];
  results: Record<string, "A" | "B">; series: Series; format: Format;
  gpLog: number[][];   // Grand Prix: each entry is one race's finishing order, as seed indices
}

// ─── Layout constants ─────────────────────────────────────────────────────────
const CARD_H    = 98;   // px — height of one compact match card
const CARD_W    = 186;  // px — width of match card column
const SLOT_BASE = 106;  // px — base slot height = CARD_H + inter-card gap (8 px)
const CONN_W    = 14;   // px — width of each connector arm
const LINE_CLR  = "rgba(22,35,59,0.2)";

const wbSlotH = (r: number) => SLOT_BASE * Math.pow(2, r - 1);
const lbSlotH = (i: number) => SLOT_BASE * Math.pow(2, Math.floor(i / 2));

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_PLAYERS = 2, MAX_PLAYERS = 16, DEFAULT_COUNT = 8;
const ITEM_ICONS  = ["🍄","🍌","⭐","🐢","💥","🔥","🪙"];
const STORAGE_KEY = "beerio-kart-state-v1";
const SESSION_KEY = "beerio-kart-session-v1";
const API = "/api";
const DEFAULT_FORMAT: Format = { series: 1, mode: "bracket", gpRaces: 3 };
type LiveStatus = "idle" | "connecting" | "live" | "error";

// ─── Grand Prix scoring (4-kart heats, points) ────────────────────────────────
const GP_POINTS = [3, 2, 1, 0];                         // 1st..4th
const gpPointsFor = (pos: number) => (pos >= 0 && pos < 4 ? GP_POINTS[pos] : 0);
const gpHeatSize = (realCount: number) => Math.min(4, Math.max(1, realCount));
function gpTotalRaces(realCount: number, target: number) {
  if (realCount < 2) return 0;
  return Math.ceil((realCount * target) / gpHeatSize(realCount));
}
function gpRaceCounts(realCount: number, gpLog: number[][]) {
  const c = new Array(realCount).fill(0);
  for (const r of gpLog) for (const s of r) if (s < realCount) c[s]++;
  return c;
}
// Next heat: the seeds who have raced the fewest times (ties: lower seed first)
function gpNextHeat(realCount: number, gpLog: number[][]) {
  const hs = gpHeatSize(realCount);
  const counts = gpRaceCounts(realCount, gpLog);
  return Array.from({ length: realCount }, (_, i) => i)
    .sort((a, b) => counts[a] - counts[b] || a - b)
    .slice(0, hs)
    .sort((a, b) => a - b);
}
function gpComplete(realCount: number, target: number, gpLog: number[][]) {
  return realCount >= 2 && gpLog.length >= gpTotalRaces(realCount, target);
}
interface GPStanding { seed: number; points: number; races: number; wins: number; rank: number; }
function gpStandings(realCount: number, gpLog: number[][]): GPStanding[] {
  const rows: GPStanding[] = Array.from({ length: realCount }, (_, seed) => ({ seed, points: 0, races: 0, wins: 0, rank: 0 }));
  for (const r of gpLog) r.forEach((seed, pos) => {
    if (seed >= realCount) return;
    rows[seed].points += gpPointsFor(pos);
    rows[seed].races++;
    if (pos === 0) rows[seed].wins++;
  });
  rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.seed - b.seed);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

// ─── Bracket engine ───────────────────────────────────────────────────────────
function nextPow2(n: number) { let s=1; while(s<n) s*=2; return Math.max(2,s); }
function seedOrder(S: number) {
  let pls=[1,2]; const rounds=Math.log2(S);
  for(let r=0;r<rounds-1;r++){
    const len=pls.length*2+1; const out:number[]=[];
    for(const d of pls){out.push(d);out.push(len-d);} pls=out;
  }
  return pls;
}
function roundTitleW(r:number,k:number){
  if(r===k)return"Winners Final"; if(r===k-1)return"Winners Semis"; return"Round "+r;
}
function roundTitleL(r:number,last:number){
  if(r===last)return"Losers Final"; if(r===last-1)return"Losers Semis"; return"Losers R"+r;
}

function buildBracket(N: number): Bracket {
  const S=nextPow2(N), k=Math.log2(S);
  const defs:MatchDef[]=[], groups:BracketGroup[]=[], wbRounds:Record<number,string[]>={};
  const lbRoundForWB:Record<number,number>={1:1};
  for(let r=2;r<=k;r++) lbRoundForWB[r]=2*r-2;
  const lastLB=2*k-2, order=seedOrder(S);

  const ids1:string[]=[];
  for(let i=0;i<S/2;i++){
    const id=`W1M${i}`;
    const drop=lbRoundForWB[1]===lastLB?"L→LF":`L→LR${lbRoundForWB[1]}`;
    defs.push({id,grp:"W1",bracket:"wb",drop,a:{t:"seed",n:order[2*i]},b:{t:"seed",n:order[2*i+1]}});
    ids1.push(id);
  }
  wbRounds[1]=ids1; groups.push({key:"W1",title:roundTitleW(1,k),bracket:"wb",ids:ids1});

  for(let r=2;r<=k;r++){
    const ids:string[]=[]; const cnt=S/Math.pow(2,r); const prev=wbRounds[r-1];
    const drop=lbRoundForWB[r]===lastLB?"L→LF":`L→LR${lbRoundForWB[r]}`;
    for(let i=0;i<cnt;i++){
      const id=`W${r}M${i}`;
      defs.push({id,grp:`W${r}`,bracket:"wb",drop,a:{t:"win",m:prev[2*i]},b:{t:"win",m:prev[2*i+1]}});
      ids.push(id);
    }
    wbRounds[r]=ids; groups.push({key:`W${r}`,title:roundTitleW(r,k),bracket:"wb",ids});
  }

  let lbFinalId:string|null=null;
  if(k>=2){
    let lr=1;
    {
      const ids:string[]=[]; const cnt=S/4;
      for(let i=0;i<cnt;i++){
        const id=`L${lr}M${i}`;
        defs.push({id,grp:`L${lr}`,bracket:"lb",a:{t:"lose",m:ids1[2*i]},b:{t:"lose",m:ids1[2*i+1]}});
        ids.push(id);
      }
      groups.push({key:`L${lr}`,title:roundTitleL(lr,lastLB),bracket:"lb",ids});
      var prevL=ids; lr++;
    }
    for(let j=1;j<=k-1;j++){
      const wbLosers=wbRounds[j+1]; const cnt=prevL.length; const idsMaj:string[]=[];
      for(let i=0;i<cnt;i++){
        const id=`L${lr}M${i}`;
        defs.push({id,grp:`L${lr}`,bracket:"lb",a:{t:"win",m:prevL[i]},b:{t:"lose",m:wbLosers[cnt-1-i]}});
        idsMaj.push(id);
      }
      groups.push({key:`L${lr}`,title:roundTitleL(lr,lastLB),bracket:"lb",ids:idsMaj});
      prevL=idsMaj; lr++;
      if(j<k-1){
        const cnt2=prevL.length/2; const idsMin:string[]=[];
        for(let i=0;i<cnt2;i++){
          const id=`L${lr}M${i}`;
          defs.push({id,grp:`L${lr}`,bracket:"lb",a:{t:"win",m:prevL[2*i]},b:{t:"win",m:prevL[2*i+1]}});
          idsMin.push(id);
        }
        groups.push({key:`L${lr}`,title:roundTitleL(lr,lastLB),bracket:"lb",ids:idsMin});
        prevL=idsMin; lr++;
      }
    }
    lbFinalId=prevL[0];
  }
  const wbFinalId=wbRounds[k][0];
  const gfB:SlotSource=k>=2?{t:"win",m:lbFinalId!}:{t:"lose",m:wbFinalId};
  if(k<2){const d=defs.find(x=>x.id===wbFinalId);if(d)d.drop="L→GF";}
  defs.push({id:"GF", grp:"GF",bracket:"gf",a:{t:"win",m:wbFinalId},b:gfB});
  defs.push({id:"GF2",grp:"GF",bracket:"gf",a:{t:"win",m:wbFinalId},b:gfB});
  groups.push({key:"GF",title:"Grand Final",bracket:"gf",ids:["GF","GF2"]});
  const byId=Object.fromEntries(defs.map(d=>[d.id,d]));
  return{defs,byId,groups,k,S};
}

function compute(BR:Bracket, names:string[], results:Record<string,"A"|"B">): Record<string,MatchResult> {
  const players:Player[]=names.map((n,i)=>({seed:i+1,name:n&&n.trim()?n.trim():null}));
  const M:Record<string,MatchResult>={};
  const resolve=(src:SlotSource):Competitor=>{
    if(src.t==="seed"){const p=players[src.n-1];return!p||p.name===null?BYE:p;}
    const m=M[src.m];if(!m||!m.decided)return TBD;
    return src.t==="win"?m.winner:m.loser;
  };
  for(const def of BR.defs){
    if(def.id==="GF2"){
      const gf=M["GF"],need=gf&&gf.decided&&gf.winSlot==="B";
      if(!need){M.GF2={a:TBD,b:TBD,winner:TBD,loser:TBD,decided:false,winSlot:null,auto:false,phantom:false,active:false,def};continue;}
    }
    const a=resolve(def.a),b=resolve(def.b);
    const aReal=a!==TBD&&a!==BYE,bReal=b!==TBD&&b!==BYE;
    let winner:Competitor=TBD,loser:Competitor=TBD,decided=false,winSlot:"A"|"B"|null=null,auto=false,phantom=false;
    if(a===BYE&&bReal){winner=b;loser=BYE;decided=true;winSlot="B";auto=true;}
    else if(b===BYE&&aReal){winner=a;loser=BYE;decided=true;winSlot="A";auto=true;}
    else if(a===BYE&&b===BYE){winner=BYE;loser=BYE;decided=true;winSlot="A";auto=true;phantom=true;}
    else if(aReal&&bReal){const r=results[def.id];if(r==="A"){winner=a;loser=b;decided=true;winSlot="A";}else if(r==="B"){winner=b;loser=a;decided=true;winSlot="B";}}
    M[def.id]={a,b,winner,loser,decided,winSlot,auto,phantom,active:true,def};
  }
  return M;
}

function getChampion(M:Record<string,MatchResult>):Player|null{
  const isReal=(p:Competitor):p is Player=>p!==TBD&&p!==BYE;
  const gf=M["GF"],gf2=M["GF2"];
  if(gf&&gf.decided&&isReal(gf.winner)){
    if(gf.winSlot==="A")return gf.winner;
    if(gf2&&gf2.decided&&isReal(gf2.winner))return gf2.winner;
  }
  return null;
}
function itemIconFor(id:string){let h=0;for(let i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return ITEM_ICONS[h%ITEM_ICONS.length];}
function matchLabel(id:string){const m=id.match(/^([WL])(\d+)M(\d+)$/);if(m)return`${m[1]}${m[2]}·${+m[3]+1}`;return id;}

// Race wins needed for a given match under the chosen format (GF keeps its own mechanic = 1 tap)
function targetFor(def:MatchDef, fmt:Format){ return def.bracket==="gf" ? 1 : fmt.series; }

// Drop results / series that are no longer valid after a change
function pruneState(BR:Bracket,names:string[],results:Record<string,"A"|"B">,series:Series){
  let r={...results}; const s:Series={...series}; let changed=true;
  while(changed){
    changed=false; const M=compute(BR,names,r);
    for(const id in r){
      const m=M[id];
      if(!m||!(m.a!==TBD&&m.a!==BYE&&m.b!==TBD&&m.b!==BYE)){delete r[id];changed=true;}
    }
  }
  const M=compute(BR,names,r);
  for(const id in s){
    const m=M[id];
    if(!m||m.auto||!(m.a!==TBD&&m.a!==BYE&&m.b!==TBD&&m.b!==BYE)){delete s[id];}
  }
  return {results:r,series:s};
}

// ─── Compact Match Card ───────────────────────────────────────────────────────

function SlotRow({m,slot,onClick,wins,target,readOnly}:{
  m:MatchResult;slot:"A"|"B";onClick:(id:string,s:"A"|"B")=>void;
  wins:number;target:number;readOnly:boolean;
}){
  const comp=slot==="A"?m.a:m.b;
  const isTbd=comp===TBD,isBye=comp===BYE,isPlayer=!isTbd&&!isBye;
  const player=isPlayer?(comp as Player):null;
  const isWin=m.decided&&!m.phantom&&m.winSlot===slot;
  const isLose=m.decided&&!m.phantom&&m.winSlot!==slot&&isPlayer;
  const clickable=isPlayer&&!m.auto&&!readOnly;
  const lb=m.def.bracket==="lb",gf=m.def.bracket==="gf";
  let bg="#EDE8DC";
  if(isWin)bg=lb?"var(--coral)":gf?"var(--grape)":"var(--grass)";
  return(
    <button disabled={!clickable} onClick={()=>clickable&&onClick(m.def.id,slot)}
      style={{background:bg,touchAction:"manipulation"}}
      className={[
        "w-full flex items-center gap-1.5 px-2 py-[5px] rounded-[6px] border border-[var(--ink)]",
        "font-[Nunito] text-[11.5px] font-bold text-left transition-all",
        isWin?"text-white":"text-[var(--ink)]",
        isLose?"opacity-50":"",
        isTbd?"border-dashed !text-[#A4AEBF] cursor-default italic":"",
        isBye?"!text-[#9AA4B5] cursor-default":"",
        clickable?"hover:brightness-105 hover:-translate-y-px active:translate-y-0 cursor-pointer":"cursor-default",
      ].join(" ")}
    >
      <span className={["inline-grid place-items-center min-w-[15px] h-[15px] rounded-[3px] text-[9.5px] font-bold flex-shrink-0 leading-none",
        isWin?"bg-black/20 text-white":"bg-[var(--ink-soft)] text-white",
        isTbd||isBye?"!bg-[#C3CAD6]":""].join(" ")}>{isTbd||isBye?"·":player?.seed}</span>
      <span className={["flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-none",isLose?"line-through decoration-[var(--coral)] decoration-[1.5px]":""].join(" ")}>
        {isTbd?"Waiting…":isBye?"Bye":player?.name}
      </span>
      {target>1&&isPlayer&&(
        <span className="flex gap-[2px] items-center flex-shrink-0">
          {Array.from({length:target}).map((_,i)=>(
            <span key={i} className="w-[5px] h-[5px] rounded-full border"
              style={{borderColor:isWin?"rgba(255,255,255,.85)":"var(--ink)",
                background:i<wins?(isWin?"#fff":"var(--ink)"):"transparent"}}/>
          ))}
        </span>
      )}
      {isWin&&<span className="text-[9px] text-white leading-none flex-shrink-0">✔</span>}
    </button>
  );
}

function MatchCard({m,onSlotClick,label,seriesMap,format,readOnly,onReset}:{
  m:MatchResult;onSlotClick:(id:string,s:"A"|"B")=>void;label?:string;
  seriesMap:Series;format:Format;readOnly:boolean;onReset:(id:string)=>void;
}){
  const icon=itemIconFor(m.def.id), lbl=label??matchLabel(m.def.id);
  const target=targetFor(m.def,format);
  const sv=seriesMap[m.def.id]||{a:0,b:0};
  const showReset=!readOnly&&target>1&&!m.auto&&(sv.a+sv.b>0);
  return(
    <div style={{height:CARD_H}}
      className={["bg-white border border-[var(--ink)] rounded-[9px] p-1.5 flex flex-col justify-between",
        "shadow-[0_2px_0_rgba(22,35,59,.13)]",m.phantom?"opacity-40":""].join(" ")}>
      <div className="flex items-center justify-between gap-1">
        <span className="font-[Fredoka] font-bold text-[9.5px] tracking-wide text-[var(--ink)] bg-[#F5EFE0] border border-[var(--ink)] rounded-[3px] px-1 py-px leading-none">{lbl}</span>
        <div className="flex items-center gap-1 min-w-0">
          {m.def.drop&&<span className="font-[Nunito] text-[8.5px] font-bold text-[var(--muted)] leading-none truncate max-w-[78px]">{m.def.drop}</span>}
          {showReset&&(
            <button onClick={()=>onReset(m.def.id)} title="Reset this heat"
              style={{touchAction:"manipulation"}}
              className="text-[10px] leading-none text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer flex-shrink-0">↺</button>
          )}
        </div>
      </div>
      <SlotRow m={m} slot="A" onClick={onSlotClick} wins={sv.a} target={target} readOnly={readOnly}/>
      <div className="flex justify-center">
        <span className="font-[Fredoka] text-[8.5px] font-bold text-[var(--ink)] bg-[var(--sun)] border border-[var(--ink)] rounded-full px-1.5 leading-none py-px" style={{transform:"rotate(-2deg)"}}>{icon} vs</span>
      </div>
      <SlotRow m={m} slot="B" onClick={onSlotClick} wins={sv.b} target={target} readOnly={readOnly}/>
    </div>
  );
}

// ─── Bracket Column (slot-height layout + connector lines) ─────────────────────
interface ColProps {
  ids: string[]; M: Record<string, MatchResult>;
  onSlotClick: (id: string, s: "A"|"B") => void;
  slotH: number; rightConn: boolean; rightPair: boolean; leftConn: boolean;
  gfLabels?: Record<string,string>;
  seriesMap: Series; format: Format; readOnly: boolean; onReset: (id:string)=>void;
}

function BracketCol({ids,M,onSlotClick,slotH,rightConn,rightPair,leftConn,gfLabels,seriesMap,format,readOnly,onReset}:ColProps){
  const totalH = ids.length * slotH;
  const totalW = CARD_W + (leftConn?CONN_W:0) + (rightConn?CONN_W:0);
  return(
    <div style={{position:"relative",width:totalW,height:totalH,flexShrink:0}}>
      {ids.map((id,i)=>{
        const cy=(i+0.5)*slotH;
        return(
          <div key={id} style={{position:"absolute",top:cy-CARD_H/2,left:leftConn?CONN_W:0,width:CARD_W}}>
            <MatchCard m={M[id]} onSlotClick={onSlotClick} label={gfLabels?.[id]}
              seriesMap={seriesMap} format={format} readOnly={readOnly} onReset={onReset}/>
          </div>
        );
      })}
      {leftConn&&ids.map((_,i)=>{
        const cy=(i+0.5)*slotH;
        return <div key={i} style={{position:"absolute",left:0,top:cy-1,width:CONN_W,height:2,background:LINE_CLR}}/>;
      })}
      {rightConn&&ids.map((_,i)=>{
        const cy=(i+0.5)*slotH;
        return <div key={i} style={{position:"absolute",right:0,top:cy-1,width:CONN_W,height:2,background:LINE_CLR}}/>;
      })}
      {rightConn&&rightPair&&Array.from({length:Math.floor(ids.length/2)},(_,pi)=>{
        const topY=(2*pi+0.5)*slotH, botY=(2*pi+1.5)*slotH;
        return <div key={pi} style={{position:"absolute",right:0,top:topY,width:2,height:botY-topY,background:LINE_CLR}}/>;
      })}
    </div>
  );
}

// ─── Bracket Section ──────────────────────────────────────────────────────────
interface SectionProps {
  groups: BracketGroup[]; M: Record<string,MatchResult>;
  onSlotClick: (id:string,s:"A"|"B")=>void;
  tagColor: string; tagText: string; pipColor: string;
  slotHFor: (i:number)=>number; rightConnFor: (i:number)=>boolean; rightPairFor: (i:number)=>boolean;
  seriesMap: Series; format: Format; readOnly: boolean; onReset: (id:string)=>void;
}

function BracketSection({groups,M,onSlotClick,tagColor,tagText,pipColor,slotHFor,rightConnFor,rightPairFor,seriesMap,format,readOnly,onReset}:SectionProps){
  return(
    <section className="mt-5">
      <div className="flex items-center gap-3 mb-2.5">
        <span className="w-3 h-3 border-2 border-[var(--ink)] rotate-45 rounded-sm flex-shrink-0" style={{background:pipColor}}/>
        <span className="font-[Luckiest_Guy,cursive] text-[17px] tracking-wider text-white rounded-[9px] px-3 py-0.5 shadow-[0_3px_0_rgba(22,35,59,.22)] flex-shrink-0"
          style={{background:tagColor,border:"2px solid var(--ink)",transform:"rotate(-1deg)"}}>{tagText}</span>
        <span className="h-[2px] bg-[var(--ink)] opacity-15 flex-1 rounded"/>
      </div>
      <div className="flex overflow-x-auto pb-2 items-start" style={{scrollbarWidth:"thin",scrollbarColor:"#C9BFA8 transparent"}}>
        {groups.map((g,gi)=>{
          const slotH=slotHFor(gi);
          const right=rightConnFor(gi);
          const pair=rightPairFor(gi);
          const left=gi>0&&rightConnFor(gi-1)&&rightPairFor(gi-1);
          return(
            <div key={g.key} className="flex-shrink-0 flex flex-col">
              <div className="font-[Fredoka] text-[10.5px] font-bold text-[var(--ink-soft)] pb-1 border-b border-dotted border-[#C9BFA8] mb-1.5"
                style={{marginLeft:left?CONN_W:0,width:CARD_W}}>
                {g.title}
              </div>
              <BracketCol
                ids={g.ids} M={M} onSlotClick={onSlotClick}
                slotH={slotH} rightConn={right} rightPair={pair} leftConn={left}
                seriesMap={seriesMap} format={format} readOnly={readOnly} onReset={onReset}/>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Beer Mug SVG ─────────────────────────────────────────────────────────────
function BeerMug({pct}:{pct:number}){
  const TOP=8,BOT=62,MUG_H=BOT-TOP;
  const fillH=Math.max(0,(pct/100)*MUG_H);
  const fillY=BOT-fillH;
  const show=fillH>0.5;
  const FOAM=9;
  return(
    <svg viewBox="0 0 56 72" width="44" height="58" style={{flexShrink:0,overflow:"visible"}}>
      <defs>
        <linearGradient id="beerGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFD055"/>
          <stop offset="60%" stopColor="#FFA820"/>
          <stop offset="100%" stopColor="#D4700A"/>
        </linearGradient>
        <clipPath id="mugClip"><polygon points="5,7 49,7 44,64 10,64"/></clipPath>
        <clipPath id="beerClip"><rect x="0" y={fillY} width="56" height={fillH+2}/></clipPath>
      </defs>
      <polygon points="5,7 49,7 44,64 10,64" fill="rgba(200,230,255,0.18)"/>
      {show&&(
        <rect x="0" width="56" clipPath="url(#mugClip)" fill="url(#beerGrad)"
          style={{y:`${fillY}px`,height:`${fillH+8}px`,transition:"y .55s ease, height .55s ease"} as React.CSSProperties}/>
      )}
      {show&&(
        <g clipPath="url(#mugClip)"
          style={{transform:`translateY(${fillY-FOAM}px)`,transition:"transform .55s ease",
            animation:"foamOscillate 3.2s ease-in-out infinite",transformOrigin:"27px 0px"}}>
          <rect x="0" y="0" width="56" height={FOAM+4} fill="white" opacity="0.96"/>
          {[6,11,16,21,26,31,36,41,46].map((cx,i)=>(<circle key={i} cx={cx} cy={1} r={5} fill="white" opacity="0.95"/>))}
          {[3,9,15,21,27,33,39,45].map((cx,i)=>(<circle key={i} cx={cx} cy={-2} r={3.2} fill="white" opacity="0.7"/>))}
        </g>
      )}
      {show&&fillH>12&&(
        <g clipPath="url(#mugClip)">
          <circle cx="21" cy={BOT-6} r="2.2" fill="rgba(255,255,255,0.55)" style={{animation:"beerBubble1 2.4s ease-in infinite"}}/>
          <circle cx="31" cy={BOT-3} r="1.5" fill="rgba(255,255,255,0.45)" style={{animation:"beerBubble2 3s ease-in .9s infinite"}}/>
          <circle cx="26" cy={BOT-10} r="1.8" fill="rgba(255,255,255,0.4)" style={{animation:"beerBubble3 2.7s ease-in 1.7s infinite"}}/>
        </g>
      )}
      <polygon points="5,7 49,7 44,64 10,64" fill="none" stroke="#16233B" strokeWidth="2.5" strokeLinejoin="round"/>
      <path d="M 49 22 C 62 22 62 52 49 52" fill="none" stroke="#16233B" strokeWidth="3" strokeLinecap="round"/>
      <path d="M 49 27 C 57 27 57 47 49 47" fill="rgba(255,255,255,0.4)" stroke="#16233B" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="5" y1="7" x2="49" y2="7" stroke="#16233B" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

// ─── Rules Modal ──────────────────────────────────────────────────────────────
const RULES = [
  {icon:"🚗",title:"No Drinking While Moving",body:"You can drink during the race, but only while your kart is stopped. Pull over, take your sips, then get back in it."},
  {icon:"🍺",title:"Finish Before You Cross",body:"Your drink must be completely finished before you cross the finish line. Cross with liquid left and your finish doesn't count, so pull back and chug."},
  {icon:"🎮",title:"Two Ways To Play",body:"Pick a mode in Settings (⚙️). Bracket is a 1v1 double-elimination ladder. Grand Prix is 4-kart heats where everyone races for points. Switching modes starts a fresh tournament."},
  {icon:"🏁",title:"Bracket: Double Elimination",body:"Two racers per match. Your first loss drops you to the Losers Bracket; a second loss knocks you out. The Losers champ fights back to the Grand Final. Set match length to single race, Best of 3, or Best of 5."},
  {icon:"⭐",title:"Bracket: Grand Final",body:"The Winners Bracket champ starts the Grand Final one game up. Win the next game and it's over. If the Losers champ takes it, the score levels and one final game decides everything."},
  {icon:"🏎️",title:"Grand Prix: 4-Kart Heats",body:"Up to four race each heat. The app builds balanced heats so everyone races the same number of times. Tap racers in finishing order to score a heat."},
  {icon:"🏆",title:"Grand Prix: Points",body:"Each heat awards 3 points for 1st, 2 for 2nd, 1 for 3rd, 0 for 4th. Points stack across all heats. Most points when the Grand Prix ends wins. Ties break by number of heat wins."},
  {icon:"🏠",title:"House Rules",body:"Agree on tracks before each race and add your own rules before the first race. Blue shells, rubber cup holders, whatever you all agree on is law."},
];
function RulesModal({onClose}:{onClose:()=>void}){
  return(
    <ModalShell onClose={onClose} title="🍺 BEERIO KART RULES" subtitle="Read before you race. Seriously.">
      <div className="px-5 py-4 flex flex-col gap-3">
        {RULES.map((r,i)=>(
          <div key={i} className="flex gap-3 bg-white border-2 border-[var(--ink)] rounded-[12px] p-3 shadow-[0_2px_0_rgba(22,35,59,.1)]">
            <span className="text-2xl flex-shrink-0 mt-0.5">{r.icon}</span>
            <div>
              <div className="font-[Fredoka] font-bold text-[14px] text-[var(--ink)] leading-tight mb-1">{r.title}</div>
              <p className="font-[Nunito] text-[12.5px] font-semibold text-[var(--ink-soft)] leading-relaxed m-0">{r.body}</p>
            </div>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

// ─── Shared Modal shell ───────────────────────────────────────────────────────
function ModalShell({title,subtitle,onClose,children}:{title:string;subtitle?:string;onClose:()=>void;children:React.ReactNode}){
  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{background:"rgba(22,35,59,0.6)",backdropFilter:"blur(4px)"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="relative w-full max-w-lg max-h-[85vh] flex flex-col bg-[var(--foam)] border-[3px] border-[var(--ink)] rounded-[18px] shadow-[0_8px_0_rgba(22,35,59,.3)]" style={{overflowY:"auto"}}>
        <div className="sticky top-0 z-10 bg-[var(--sun)] border-b-[3px] border-[var(--ink)] px-5 py-3 flex items-center justify-between rounded-t-[15px]">
          <div>
            <h2 className="font-[Luckiest_Guy,cursive] text-[20px] text-[var(--ink)] leading-none tracking-wider m-0" style={{textShadow:"2px 2px 0 rgba(22,35,59,.15)"}}>{title}</h2>
            {subtitle&&<p className="font-[Fredoka] font-semibold text-[11px] text-[var(--ink)] opacity-70 mt-0.5 m-0 tracking-wide">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-[8px] border-2 border-[var(--ink)] bg-white text-[var(--ink)] font-bold text-lg grid place-items-center shadow-[0_2px_0_rgba(22,35,59,.22)] hover:bg-[#F5EFE0] active:translate-y-px transition-all cursor-pointer" style={{touchAction:"manipulation"}}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Format / Settings Modal ──────────────────────────────────────────────────
function FormatModal({format,onChange,onClose}:{format:Format;onChange:(f:Partial<Format>,resetNeeded:boolean)=>void;onClose:()=>void}){
  const modeOpts:{v:Mode;label:string;sub:string;icon:string}[]=[
    {v:"bracket",icon:"🏁",label:"Bracket",sub:"1v1 double-elimination ladder"},
    {v:"gp",icon:"🏎️",label:"Grand Prix",sub:"4-kart heats, race for points"},
  ];
  const seriesOpts:{v:SeriesLen;label:string;sub:string}[]=[
    {v:1,label:"Single race",sub:"One race per match"},
    {v:2,label:"Best of 3",sub:"First to 2 race wins"},
    {v:3,label:"Best of 5",sub:"First to 3 race wins"},
  ];
  const gpOpts:{v:number;label:string;sub:string}[]=[
    {v:3,label:"Short (3 each)",sub:"Everyone races at least 3 heats"},
    {v:4,label:"Standard (4 each)",sub:"Everyone races at least 4 heats"},
    {v:5,label:"Long (5 each)",sub:"Everyone races at least 5 heats"},
  ];
  const Row=({active,onClick,icon,label,sub}:{active:boolean;onClick:()=>void;icon?:string;label:string;sub:string})=>(
    <button onClick={onClick} style={{touchAction:"manipulation"}}
      className={`flex items-center justify-between text-left px-3 py-2 rounded-[10px] border-2 border-[var(--ink)] cursor-pointer transition-all ${active?"bg-[var(--sun)] shadow-[0_2px_0_rgba(22,35,59,.22)]":"bg-white hover:bg-[#F5EFE0]"}`}>
      <span className="flex items-center gap-2">
        {icon&&<span className="text-[17px]">{icon}</span>}
        <span><span className="font-[Fredoka] font-bold text-[13px] text-[var(--ink)]">{label}</span><span className="block font-[Nunito] text-[11px] font-semibold text-[var(--muted)]">{sub}</span></span>
      </span>
      {active&&<span className="text-[var(--ink)] font-bold">✓</span>}
    </button>
  );
  return(
    <ModalShell onClose={onClose} title="⚙️ FORMAT" subtitle="Set this before you start racing.">
      <div className="px-5 py-4 flex flex-col gap-5">
        <div>
          <div className="font-[Fredoka] font-bold text-[13px] text-[var(--ink)] mb-2">Tournament mode</div>
          <div className="flex flex-col gap-2">
            {modeOpts.map(o=>(
              <Row key={o.v} active={format.mode===o.v} icon={o.icon} label={o.label} sub={o.sub}
                onClick={()=>onChange({mode:o.v}, o.v!==format.mode)}/>
            ))}
          </div>
          <p className="font-[Nunito] text-[10.5px] font-semibold text-[var(--muted)] mt-1.5 leading-snug">Switching modes starts a fresh tournament.</p>
        </div>

        {format.mode==="bracket"?(
          <div>
            <div className="font-[Fredoka] font-bold text-[13px] text-[var(--ink)] mb-2">Match length</div>
            <div className="flex flex-col gap-2">
              {seriesOpts.map(o=>(
                <Row key={o.v} active={format.series===o.v} label={o.label} sub={o.sub}
                  onClick={()=>onChange({series:o.v}, o.v!==format.series)}/>
              ))}
            </div>
            <p className="font-[Nunito] text-[10.5px] font-semibold text-[var(--muted)] mt-1.5 leading-snug">Changing match length clears recorded results. The Grand Final always uses the winners-bracket head start.</p>
          </div>
        ):(
          <div>
            <div className="font-[Fredoka] font-bold text-[13px] text-[var(--ink)] mb-2">Grand Prix length</div>
            <div className="flex flex-col gap-2">
              {gpOpts.map(o=>(
                <Row key={o.v} active={format.gpRaces===o.v} label={o.label} sub={o.sub}
                  onClick={()=>onChange({gpRaces:o.v}, o.v!==format.gpRaces)}/>
              ))}
            </div>
            <p className="font-[Nunito] text-[10.5px] font-semibold text-[var(--muted)] mt-1.5 leading-snug">3 points for 1st, 2 for 2nd, 1 for 3rd, 0 for 4th. Most points wins. Changing length clears recorded heats.</p>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

// ─── Share / Spectator (QR) Modal ─────────────────────────────────────────────
function CopyRow({value,id,copied,onCopy}:{value:string;id:"live"|"snap";copied:""|"live"|"snap";onCopy:(id:"live"|"snap",v:string)=>void}){
  return(
    <div className="w-full flex items-center gap-2">
      <input readOnly value={value} onFocus={e=>e.currentTarget.select()}
        className="flex-1 min-w-0 px-2.5 py-2 bg-white border-2 border-[var(--ink)] rounded-[9px] font-[Nunito] text-[11px] font-semibold text-[var(--ink-soft)] outline-none truncate"/>
      <button onClick={()=>onCopy(id,value)} style={{touchAction:"manipulation"}}
        className="flex-shrink-0 px-3 py-2 rounded-[9px] border-2 border-[var(--ink)] bg-[var(--sun)] hover:bg-[var(--sun-deep)] font-[Fredoka] font-semibold text-[12px] text-[var(--ink)] shadow-[0_2px_0_rgba(22,35,59,.22)] active:translate-y-px transition-all cursor-pointer">
        {copied===id?"Copied!":"Copy"}
      </button>
    </div>
  );
}

function ShareModal({code,status,liveUrl,snapshotUrl,onClose,onRetry}:{
  code:string|null;status:LiveStatus;liveUrl:string;snapshotUrl:string;onClose:()=>void;onRetry:()=>void;
}){
  const [copied,setCopied]=useState<""|"live"|"snap">("");
  const copy=async(id:"live"|"snap",val:string)=>{
    try{await navigator.clipboard.writeText(val);setCopied(id);setTimeout(()=>setCopied(""),1500);}catch{/* clipboard blocked */}
  };
  return(
    <ModalShell onClose={onClose} title="📺 SPECTATOR VIEW" subtitle="Scan to follow the bracket live on another screen.">
      <div className="px-5 py-5 flex flex-col items-center gap-4">
        {status==="connecting"&&!code&&(
          <div className="py-10 flex flex-col items-center gap-3">
            <span className="text-3xl animate-pulse">📡</span>
            <p className="font-[Fredoka] font-semibold text-[13px] text-[var(--muted)] m-0">Starting live session…</p>
          </div>
        )}
        {status==="error"&&!code&&(
          <div className="w-full flex flex-col items-center gap-3 text-center">
            <span className="text-3xl">🔌</span>
            <p className="font-[Nunito] font-semibold text-[12.5px] text-[var(--ink-soft)] m-0 leading-relaxed">
              Couldn't reach the live server. Make sure the app is running with its API server (see setup notes), or use the one-time snapshot link below.
            </p>
            <button onClick={onRetry} style={{touchAction:"manipulation"}}
              className="px-4 py-2 rounded-[9px] border-2 border-[var(--ink)] bg-[var(--sun)] hover:bg-[var(--sun-deep)] font-[Fredoka] font-semibold text-[12.5px] text-[var(--ink)] shadow-[0_2px_0_rgba(22,35,59,.22)] active:translate-y-px transition-all cursor-pointer">
              Try again
            </button>
          </div>
        )}
        {code&&(
          <>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{background:status==="live"?"var(--grass)":"var(--coral)",boxShadow:"0 0 0 2px rgba(22,35,59,.15)"}}/>
              <span className="font-[Fredoka] font-bold text-[12.5px] text-[var(--ink)] tracking-wide">{status==="live"?"LIVE":"reconnecting…"} · Room {code}</span>
            </div>
            <div className="bg-white border-[3px] border-[var(--ink)] rounded-[14px] p-3 shadow-[0_3px_0_rgba(22,35,59,.18)]">
              <QRCodeSVG value={liveUrl} size={196} bgColor="#FFFFFF" fgColor="#16233B" level="M" includeMargin={false}/>
            </div>
            <p className="font-[Nunito] text-[12px] font-semibold text-[var(--muted)] text-center leading-relaxed m-0">
              Scan to watch the bracket update in real time as you record results. Anyone with the link follows along live, but can't edit.
            </p>
            <CopyRow value={liveUrl} id="live" copied={copied} onCopy={copy}/>
          </>
        )}
        <details className="w-full">
          <summary className="cursor-pointer font-[Nunito] text-[11px] font-bold text-[var(--muted)] select-none">One-time snapshot link (no live updates)</summary>
          <p className="font-[Nunito] text-[10.5px] font-semibold text-[var(--muted)] mt-1.5 mb-2 leading-snug">A frozen copy of the bracket right now. Works without the server, but won't refresh.</p>
          <CopyRow value={snapshotUrl} id="snap" copied={copied} onCopy={copy}/>
        </details>
      </div>
    </ModalShell>
  );
}

// ─── Match History ────────────────────────────────────────────────────────────
function MatchHistory({BR,M,series,groupTitleById}:{BR:Bracket;M:Record<string,MatchResult>;series:Series;groupTitleById:Record<string,string>}){
  const [open,setOpen]=useState(false);
  const rows=BR.defs
    .filter(d=>{const m=M[d.id];return m&&m.active&&m.decided&&!m.auto&&!m.phantom;})
    .map(d=>{
      const m=M[d.id];
      const w=m.winner as Player;
      const lname=(m.loser!==TBD&&m.loser!==BYE)?(m.loser as Player).name:"Bye";
      const round=d.bracket==="gf"?(d.id==="GF2"?"Grand Final (Reset)":"Grand Final"):`${groupTitleById[d.id]} · ${matchLabel(d.id)}`;
      const sv=series[d.id];
      const score=sv&&(sv.a+sv.b>0)?(m.winSlot==="A"?`${sv.a}–${sv.b}`:`${sv.b}–${sv.a}`):null;
      return {id:d.id,round,winner:w.name,loser:lname,score};
    });
  if(rows.length===0)return null;
  return(
    <div className="mt-6 border-t-2 border-dotted border-[#C9BFA8] pt-3">
      <button onClick={()=>setOpen(o=>!o)} style={{touchAction:"manipulation"}}
        className="w-full flex items-center justify-between font-[Fredoka] font-bold text-[13px] text-[var(--ink)] cursor-pointer py-1">
        <span>📜 Match History <span className="text-[var(--muted)] font-semibold">({rows.length})</span></span>
        <span className={`transition-transform ${open?"rotate-90":""}`}>▸</span>
      </button>
      {open&&(
        <div className="mt-2 flex flex-col gap-1.5">
          {rows.map((r,i)=>(
            <div key={r.id} className="flex items-center gap-2 bg-white border border-[var(--ink)] rounded-[8px] px-2.5 py-1.5 shadow-[0_1px_0_rgba(22,35,59,.1)]">
              <span className="font-[Fredoka] font-bold text-[9px] text-[var(--ink-soft)] w-5 flex-shrink-0">{i+1}</span>
              <span className="font-[Fredoka] font-bold text-[9.5px] text-[var(--ink)] bg-[#F5EFE0] border border-[var(--ink)] rounded-[3px] px-1.5 py-px leading-none flex-shrink-0 min-w-[92px]">{r.round}</span>
              <span className="font-[Nunito] text-[12px] font-bold text-[var(--ink)] flex-1 min-w-0 truncate">
                <span className="text-[var(--grass-deep)]">{r.winner}</span>
                <span className="text-[var(--muted)] font-semibold"> def. </span>
                <span className="text-[var(--ink-soft)]">{r.loser}</span>
              </span>
              {r.score&&<span className="font-[Fredoka] font-bold text-[11px] text-[var(--ink)] flex-shrink-0">{r.score}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Grand Prix view ──────────────────────────────────────────────────────────
const POS_LABEL = ["1st","2nd","3rd","4th"];
const POS_COLOR = ["var(--sun)","#D8DEE9","#E8B98A","#EDE8DC"];

function GrandPrix({names,realCount,gpLog,target,readOnly,onRecord,onUndo}:{
  names:string[];realCount:number;gpLog:number[][];target:number;readOnly:boolean;
  onRecord:(order:number[])=>void;onUndo:()=>void;
}){
  const nameOf=(seed:number)=>names[seed]?.trim()||`Racer ${seed+1}`;
  const total=gpTotalRaces(realCount,target);
  const done=gpLog.length;
  const complete=gpComplete(realCount,target,gpLog);
  const standings=gpStandings(realCount,gpLog);
  const heat=complete?[]:gpNextHeat(realCount,gpLog);

  // in-progress finishing order (local, host only)
  const [order,setOrder]=useState<number[]>([]);
  const [logOpen,setLogOpen]=useState(false);
  // reset the in-progress order whenever the heat changes (new race or undo)
  const heatKey=heat.join(",")+"|"+done;
  const [lastKey,setLastKey]=useState(heatKey);
  if(heatKey!==lastKey){ setLastKey(heatKey); if(order.length) setOrder([]); }

  const tap=(seed:number)=>{
    if(readOnly||order.includes(seed))return;
    let next=[...order,seed];
    // auto-place the final racer when only one remains
    const remaining=heat.filter(s=>!next.includes(s));
    if(remaining.length===1)next=[...next,remaining[0]];
    setOrder(next);
  };
  const placed=(seed:number)=>order.indexOf(seed);
  const ready=order.length===heat.length&&heat.length>0;

  const raceLog=done===0?null:(
    <div className="mt-5 border-t-2 border-dotted border-[#C9BFA8] pt-3">
      <button onClick={()=>setLogOpen(o=>!o)} style={{touchAction:"manipulation"}}
        className="w-full flex items-center justify-between font-[Fredoka] font-bold text-[13px] text-[var(--ink)] cursor-pointer py-1">
        <span>📜 Heat History <span className="text-[var(--muted)] font-semibold">({done})</span></span>
        <span className={`transition-transform ${logOpen?"rotate-90":""}`}>▸</span>
      </button>
      {logOpen&&(
        <div className="mt-2 flex flex-col gap-1.5">
          {gpLog.map((race,i)=>(
            <div key={i} className="flex items-center gap-2 bg-white border border-[var(--ink)] rounded-[8px] px-2.5 py-1.5 shadow-[0_1px_0_rgba(22,35,59,.1)]">
              <span className="font-[Fredoka] font-bold text-[9px] text-[var(--ink-soft)] w-10 flex-shrink-0">Heat {i+1}</span>
              <span className="font-[Nunito] text-[11.5px] font-bold text-[var(--ink)] flex-1 min-w-0 truncate">
                {race.map((seed,pos)=>(
                  <span key={pos}>
                    <span style={{color:pos===0?"var(--grass-deep)":"var(--ink-soft)"}}>{POS_LABEL[pos]} {nameOf(seed)}</span>
                    {pos<race.length-1?<span className="text-[var(--muted)]">{"  ·  "}</span>:null}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return(
    <section className="mt-5">
      <div className="flex items-center gap-3 mb-3">
        <span className="w-3 h-3 border-2 border-[var(--ink)] rotate-45 rounded-sm flex-shrink-0" style={{background:"var(--grape)"}}/>
        <span className="font-[Luckiest_Guy,cursive] text-[17px] tracking-wider text-white rounded-[9px] px-3 py-0.5 shadow-[0_3px_0_rgba(22,35,59,.22)] flex-shrink-0"
          style={{background:"var(--grape)",border:"2px solid var(--ink)",transform:"rotate(-1deg)"}}>Grand Prix</span>
        <span className="font-[Fredoka] font-bold text-[12px] text-[var(--ink-soft)] flex-shrink-0">Heat {Math.min(done+ (complete?0:1),total)} of {total}</span>
        <span className="h-[2px] bg-[var(--ink)] opacity-15 flex-1 rounded"/>
      </div>

      <div className="flex flex-wrap gap-5 items-start">
        {/* Current heat / champion */}
        <div className="flex-1 min-w-[280px]">
          {complete?(
            <div className="rounded-2xl border-[3px] border-[var(--ink)] flex flex-col items-center justify-center gap-3 px-8 py-8 text-center"
              style={{background:"radial-gradient(130% 130% at 50% -10%,rgba(255,192,46,.7),rgba(255,192,46,0) 62%),var(--card2)",boxShadow:"0 6px 0 rgba(22,35,59,.22), 0 12px 32px rgba(22,35,59,.12)",animation:"champPop .4s cubic-bezier(.34,1.56,.64,1) both"}}>
              <span style={{fontSize:52,lineHeight:1,filter:"drop-shadow(0 4px 0 rgba(22,35,59,.18))",animation:"champBounce 1.8s ease-in-out infinite"}}>🍻</span>
              <div>
                <div className="font-[Fredoka] tracking-[3px] text-[11px] text-[var(--sun-deep)] font-bold uppercase mb-1">🏆 Grand Prix Champion 🏆</div>
                <div className="font-[Luckiest_Guy,cursive] text-[clamp(22px,4vw,34px)] text-[var(--ink)] leading-tight tracking-wide" style={{textShadow:"2px 2px 0 rgba(22,35,59,.1)"}}>{nameOf(standings[0].seed)}</div>
                <div className="font-[Fredoka] font-semibold text-[13px] text-[var(--ink-soft)] mt-1">{standings[0].points} pts over {standings[0].races} heats</div>
              </div>
              {!readOnly&&<button onClick={onUndo} style={{touchAction:"manipulation"}}
                className="font-[Fredoka] font-semibold text-[12px] bg-white text-[var(--ink)] border-2 border-[var(--ink)] rounded-[9px] px-3 py-1.5 shadow-[0_2px_0_rgba(22,35,59,.22)] active:translate-y-px cursor-pointer">↺ Undo last heat</button>}
            </div>
          ):(
            <div className="rounded-2xl border-[3px] border-[var(--ink)] bg-white p-4 shadow-[0_4px_0_rgba(22,35,59,.14)]">
              <div className="flex items-center justify-between mb-3">
                <span className="font-[Fredoka] font-bold text-[14px] text-[var(--ink)]">🏁 Now Racing</span>
                <span className="font-[Nunito] font-bold text-[10.5px] text-[var(--muted)]">{readOnly?"Tap order on host screen":"Tap in finishing order"}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {heat.map(seed=>{
                  const p=placed(seed);
                  const assigned=p>=0;
                  return(
                    <button key={seed} disabled={readOnly||assigned} onClick={()=>tap(seed)} style={{touchAction:"manipulation"}}
                      className={`relative flex items-center gap-2 px-3 py-3 rounded-[11px] border-2 border-[var(--ink)] text-left transition-all ${assigned?"":"bg-[#F7F2E6] hover:bg-[var(--sun)] cursor-pointer active:translate-y-px"} ${readOnly&&!assigned?"opacity-90 cursor-default":""}`}>
                      <span className="inline-grid place-items-center w-[22px] h-[22px] rounded-[5px] border border-[var(--ink)] text-[10px] font-bold flex-shrink-0"
                        style={{background:assigned?POS_COLOR[p]:"#fff",color:"var(--ink)"}}>{assigned?p+1:"·"}</span>
                      <span className="font-[Fredoka] font-bold text-[13px] text-[var(--ink)] flex-1 min-w-0 truncate">{nameOf(seed)}</span>
                      {assigned&&<span className="font-[Nunito] font-bold text-[10px] text-[var(--muted)] flex-shrink-0">{POS_LABEL[p]} · +{gpPointsFor(p)}</span>}
                    </button>
                  );
                })}
              </div>
              {!readOnly&&(
                <div className="flex items-center gap-2 mt-3">
                  <button disabled={!ready} onClick={()=>{if(ready){onRecord(order);setOrder([]);}}} style={{touchAction:"manipulation"}}
                    className={`flex-1 font-[Fredoka] font-bold text-[13px] px-3 py-2.5 rounded-[10px] border-2 border-[var(--ink)] shadow-[0_3px_0_rgba(22,35,59,.22)] transition-all ${ready?"bg-[var(--grass)] text-white hover:brightness-105 active:translate-y-px cursor-pointer":"bg-[#E7E2D5] text-[var(--muted)] cursor-default"}`}>
                    {ready?"✔ Save heat result":`Tap ${heat.length-order.length} more`}
                  </button>
                  {order.length>0&&<button onClick={()=>setOrder([])} style={{touchAction:"manipulation"}}
                    className="font-[Fredoka] font-semibold text-[12px] bg-white text-[var(--ink)] border-2 border-[var(--ink)] rounded-[10px] px-3 py-2.5 shadow-[0_2px_0_rgba(22,35,59,.22)] active:translate-y-px cursor-pointer">Clear</button>}
                  {done>0&&<button onClick={onUndo} title="Undo last saved heat" style={{touchAction:"manipulation"}}
                    className="font-[Fredoka] font-semibold text-[12px] bg-white text-[var(--ink)] border-2 border-[var(--ink)] rounded-[10px] px-3 py-2.5 shadow-[0_2px_0_rgba(22,35,59,.22)] active:translate-y-px cursor-pointer">↺</button>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Leaderboard */}
        <div className="flex-1 min-w-[260px]">
          <div className="font-[Fredoka] font-bold text-[12px] text-[var(--ink-soft)] mb-1.5 pb-1 border-b border-dotted border-[#C9BFA8]">🏆 Standings</div>
          <div className="flex flex-col gap-1.5">
            {standings.map(r=>{
              const leader=r.rank===1&&done>0;
              return(
                <div key={r.seed} className={`flex items-center gap-2 border-2 border-[var(--ink)] rounded-[9px] px-2.5 py-1.5 ${leader?"bg-[var(--sun)] shadow-[0_2px_0_rgba(22,35,59,.18)]":"bg-white"}`}>
                  <span className="font-[Luckiest_Guy,cursive] text-[14px] text-[var(--ink)] w-6 flex-shrink-0 text-center">{r.rank}</span>
                  <span className="font-[Fredoka] font-bold text-[13px] text-[var(--ink)] flex-1 min-w-0 truncate">{nameOf(r.seed)}</span>
                  <span className="font-[Nunito] font-bold text-[10px] text-[var(--muted)] flex-shrink-0">{r.races} heats</span>
                  <span className="font-[Luckiest_Guy,cursive] text-[16px] text-[var(--ink)] flex-shrink-0 min-w-[26px] text-right">{r.points}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 font-[Nunito] text-[10.5px] font-semibold text-[var(--muted)] leading-snug">3 / 2 / 1 / 0 points for 1st through 4th. Most points after {total} heats wins.</p>
        </div>
      </div>

      {raceLog}
    </section>
  );
}

// ─── Spectator state encode / decode ──────────────────────────────────────────
function encodeShare(s:SavedState):string{ return compressToEncodedURIComponent(JSON.stringify(s)); }
function buildShareURL(s:SavedState):string{
  const base=(typeof location!=="undefined")?location.origin+location.pathname:"";
  return `${base}#v=${encodeShare(s)}`;
}
function readSpectator():SavedState|null{
  if(typeof location==="undefined")return null;
  const m=(location.hash||"").match(/[#&]v=([^&]+)/);
  if(!m)return null;
  try{
    const raw=decompressFromEncodedURIComponent(m[1]);
    if(!raw)return null;
    const obj=JSON.parse(raw);
    if(obj&&Array.isArray(obj.names)&&typeof obj.playerCount==="number")return obj as SavedState;
  }catch{/* malformed */}
  return null;
}
function loadSaved():SavedState|null{
  if(typeof localStorage==="undefined")return null;
  try{const raw=localStorage.getItem(STORAGE_KEY);if(raw){const o=JSON.parse(raw);if(o&&Array.isArray(o.names))return o as SavedState;}}catch{/* ignore */}
  return null;
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App(){
  const spectatorInit=useMemo(()=>readSpectator(),[]);
  const liveCode=useMemo(()=>(typeof location!=="undefined")?new URLSearchParams(location.search).get("s"):null,[]);
  const isLive=!!liveCode;
  const isSpectator=!!spectatorInit||isLive;
  const initial=useMemo<SavedState>(()=>{
    const base=spectatorInit ?? (isSpectator?null:loadSaved());
    if(base)return {
      playerCount:base.playerCount,
      names:base.names.slice(0,base.playerCount).concat(Array(Math.max(0,base.playerCount-base.names.length)).fill("")),
      results:base.results||{},
      series:base.series||{},
      format:{...DEFAULT_FORMAT,...(base.format||{})},
      gpLog:Array.isArray(base.gpLog)?base.gpLog:[],
    };
    return {playerCount:DEFAULT_COUNT,names:Array(DEFAULT_COUNT).fill(""),results:{},series:{},format:DEFAULT_FORMAT,gpLog:[]};
  },[spectatorInit,isSpectator]);

  const [playerCount,setPlayerCount]=useState(initial.playerCount);
  const [names,setNames]=useState<string[]>(initial.names);
  const [results,setResults]=useState<Record<string,"A"|"B">>(initial.results);
  const [series,setSeries]=useState<Series>(initial.series);
  const [format,setFormat]=useState<Format>(initial.format);
  const [gpLog,setGpLog]=useState<number[][]>(initial.gpLog);
  const [BR,setBR]=useState<Bracket>(()=>buildBracket(initial.playerCount));
  const [rulesOpen,setRulesOpen]=useState(false);
  const [formatOpen,setFormatOpen]=useState(false);
  const [shareOpen,setShareOpen]=useState(false);
  const [sessionCode,setSessionCode]=useState<string|null>(()=>{
    if(isLive||typeof localStorage==="undefined")return null;
    try{return localStorage.getItem(SESSION_KEY)||null;}catch{return null;}
  });
  const [liveStatus,setLiveStatus]=useState<LiveStatus>(isLive?"connecting":"idle");

  // Persist (host only — never overwrite saved state while viewing a shared snapshot)
  useEffect(()=>{
    if(isSpectator||typeof localStorage==="undefined")return;
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({playerCount,names,results,series,format,gpLog}));}catch{/* quota */}
  },[isSpectator,playerCount,names,results,series,format,gpLog]);

  // Host: push state to the live room (debounced) whenever it changes
  useEffect(()=>{
    if(isSpectator||!sessionCode)return;
    const t=setTimeout(()=>{
      fetch(`${API}/sessions/${sessionCode}`,{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({state:{playerCount,names,results,series,format,gpLog}})})
        .then(r=>{if(!r.ok)throw new Error();setLiveStatus("live");})
        .catch(()=>setLiveStatus("error"));
    },600);
    return ()=>clearTimeout(t);
  },[isSpectator,sessionCode,playerCount,names,results,series,format,gpLog]);

  // Spectator: poll the live room every few seconds and mirror its state
  useEffect(()=>{
    if(!liveCode)return;
    let active=true;
    const apply=(s:Partial<SavedState>|undefined)=>{
      if(!active||!s)return;
      const pc=Math.max(MIN_PLAYERS,Math.min(MAX_PLAYERS,Number(s.playerCount)||DEFAULT_COUNT));
      setPlayerCount(pc);
      setNames(()=>{const a=Array.isArray(s.names)?[...s.names].slice(0,pc):[];while(a.length<pc)a.push("");return a;});
      setResults(s.results||{});
      setSeries(s.series||{});
      setFormat({...DEFAULT_FORMAT,...(s.format||{})});
      setGpLog(Array.isArray(s.gpLog)?s.gpLog:[]);
      setBR(buildBracket(pc));
    };
    const tick=async()=>{
      try{
        const r=await fetch(`${API}/sessions/${liveCode}`);
        if(r.ok){const d=await r.json();apply(d.state);setLiveStatus("live");}
        else setLiveStatus("error");
      }catch{setLiveStatus("error");}
    };
    tick();
    const id=setInterval(tick,3000);
    return ()=>{active=false;clearInterval(id);};
  },[liveCode]);

  // Host: open a live room (create on first share, reuse the saved code after)
  const startLive=useCallback(async ()=>{
    setLiveStatus("connecting");
    const payload=JSON.stringify({state:{playerCount,names,results,series,format,gpLog}});
    try{
      if(sessionCode){
        const r=await fetch(`${API}/sessions/${sessionCode}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:payload});
        if(!r.ok)throw new Error();
        setLiveStatus("live");return;
      }
      const r=await fetch(`${API}/sessions`,{method:"POST",headers:{"Content-Type":"application/json"},body:payload});
      if(!r.ok)throw new Error();
      const {code}=await r.json();
      setSessionCode(code);
      try{localStorage.setItem(SESSION_KEY,code);}catch{/* ignore */}
      setLiveStatus("live");
    }catch{setLiveStatus("error");}
  },[sessionCode,playerCount,names,results,series,format,gpLog]);

  const handleSetCount=useCallback((n:number)=>{
    const next=Math.max(MIN_PLAYERS,Math.min(MAX_PLAYERS,n));
    if(next===playerCount)return;
    setPlayerCount(next);
    setNames(prev=>{const a=[...prev];while(a.length<next)a.push("");return a.slice(0,next);});
    setResults({});setSeries({});setGpLog([]);setBR(buildBracket(next));
  },[playerCount]);

  const handleNameChange=useCallback((i:number,val:string)=>{
    setNames(prev=>{const a=[...prev];a[i]=val;return a;});
  },[]);

  const handleShuffle=useCallback(()=>{
    setNames(prev=>{
      const real=prev.map(n=>n.trim()).filter(Boolean);
      for(let i=real.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[real[i],real[j]]=[real[j],real[i]];}
      return prev.map((_,i)=>real[i]||"");
    });setResults({});setSeries({});setGpLog([]);
  },[]);

  const handleReset=useCallback(()=>{setResults({});setSeries({});setGpLog([]);},[]);
  const handleClearAll=useCallback(()=>{setNames(Array(playerCount).fill(""));setResults({});setSeries({});setGpLog([]);},[playerCount]);

  // Grand Prix: record / undo a heat result
  const handleRecordRace=useCallback((order:number[])=>{
    if(isSpectator)return;
    setGpLog(prev=>[...prev,order]);
  },[isSpectator]);
  const handleUndoRace=useCallback(()=>{
    if(isSpectator)return;
    setGpLog(prev=>prev.slice(0,-1));
  },[isSpectator]);

  const handleSlotClick=useCallback((matchId:string,slot:"A"|"B")=>{
    if(isSpectator)return;
    const def=BR.byId[matchId];
    const target=def?targetFor(def,format):1;
    let nextR={...results};
    const nextS:Series={...series};
    if(target<=1){
      if(nextR[matchId]===slot)delete nextR[matchId];else nextR[matchId]=slot;
      delete nextS[matchId];
    }else{
      if(nextR[matchId]){ // already decided → undo whole match
        delete nextR[matchId];delete nextS[matchId];
      }else{
        const cur=nextS[matchId]||{a:0,b:0};
        const s={a:cur.a,b:cur.b};
        if(slot==="A")s.a++;else s.b++;
        nextS[matchId]=s;
        if(s.a>=target||s.b>=target)nextR[matchId]=s.a>s.b?"A":"B";
      }
    }
    const cleaned=pruneState(BR,names,nextR,nextS);
    setResults(cleaned.results);setSeries(cleaned.series);
  },[isSpectator,BR,format,results,series,names]);

  const handleResetMatch=useCallback((matchId:string)=>{
    if(isSpectator)return;
    const nextR={...results};const nextS:Series={...series};
    delete nextR[matchId];delete nextS[matchId];
    const cleaned=pruneState(BR,names,nextR,nextS);
    setResults(cleaned.results);setSeries(cleaned.series);
  },[isSpectator,BR,results,series,names]);

  const handleFormatChange=useCallback((partial:Partial<Format>,resetNeeded:boolean)=>{
    if(resetNeeded){
      const msg=partial.mode?"Switching modes starts a fresh tournament. Continue?":"Changing the format clears recorded results. Continue?";
      const ok=typeof window==="undefined"?true:window.confirm(msg);
      if(!ok)return;
      setResults({});setSeries({});setGpLog([]);
    }
    setFormat(f=>({...f,...partial}));
  },[]);

  const editCopy=useCallback(()=>{
    // Spectator → take a local editable copy
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({playerCount,names,results,series,format,gpLog}));}catch{/* ignore */}
    location.href=location.origin+location.pathname;
  },[playerCount,names,results,series,format,gpLog]);

  const M=compute(BR,names,results);
  const champ=getChampion(M);
  const realCount=names.filter(n=>n&&n.trim()).length;
  const isGP=format.mode==="gp";

  // Heats counter: fixed denominator from the start.
  // Bracket: a double-elim with N real racers always plays 2N-2 heats (plus one if a Grand Final reset is forced).
  // Grand Prix: the planned number of heats for everyone to race the chosen amount.
  let done=0,total=0;
  if(isGP){
    done=gpLog.length;
    total=gpTotalRaces(realCount,format.gpRaces);
  }else{
    for(const id in M){
      const m=M[id];if(!m.active)continue;
      const aR=m.a!==TBD&&m.a!==BYE,bR=m.b!==TBD&&m.b!==BYE;
      if(aR&&bR&&!m.auto&&m.decided)done++;
    }
    const gfReset=!!(M["GF2"]&&M["GF2"].active);
    total=realCount>=2?(2*realCount-2+(gfReset?1:0)):0;
  }
  const pct=total?Math.round(done/total*100):0;
  const S=nextPow2(playerCount),byes=S-playerCount;
  const capText=byes>0?`${byes} bye${byes>1?"s":""}→${S}-slot`:`clean ${S}-slot`;

  const wbGroups=BR.groups.filter(g=>g.bracket==="wb");
  const lbGroups=BR.groups.filter(g=>g.bracket==="lb");
  const gfMatches=M["GF2"]&&M["GF2"].active?["GF","GF2"]:["GF"];
  const showReset=M["GF"]?.decided&&M["GF"]?.winSlot==="B"&&!(M["GF2"]?.decided);

  const gfMatch=M["GF"];
  const gfA=gfMatch?.a!==TBD&&gfMatch?.a!==BYE&&gfMatch?.a?(gfMatch.a as Player).name??null:null;
  const gfB=gfMatch?.b!==TBD&&gfMatch?.b!==BYE&&gfMatch?.b?(gfMatch.b as Player).name??null:null;
  const gfBothKnown=!!(gfA&&gfB);
  let gfScoreA=1,gfScoreB=0;
  if(gfMatch?.decided){if(gfMatch.winSlot==="A")gfScoreA++;else gfScoreB++;}

  const wbRightConn=(i:number)=>i<wbGroups.length-1;
  const wbRightPair=(_i:number)=>true;
  const lbRightConn=(i:number)=>i%2===1&&i<lbGroups.length-1;
  const lbRightPair=(_i:number)=>true;

  const groupTitleById=useMemo(()=>{
    const map:Record<string,string>={};
    for(const g of BR.groups)for(const id of g.ids)map[id]=g.title;
    return map;
  },[BR]);

  const liveUrl=useMemo(()=>(sessionCode&&typeof location!=="undefined")?`${location.origin}${location.pathname}?s=${sessionCode}`:"",[sessionCode]);
  const snapshotUrl=useMemo(()=>shareOpen?buildShareURL({playerCount,names,results,series,format,gpLog}):"",[shareOpen,playerCount,names,results,series,format,gpLog]);

  return(
    <>
      {/* Portrait blocker (tablets only) */}
      <div className="app-portrait-blocker">
        <div className="rp-card">
          <span className="rp-ic">📱</span>
          <h2>TURN ME SIDEWAYS</h2>
          <p>This bracket is built for landscape. Rotate to start racing.</p>
        </div>
      </div>

      <div className="app-main min-h-screen">
        {rulesOpen&&<RulesModal onClose={()=>setRulesOpen(false)}/>}
        {formatOpen&&<FormatModal format={format} onChange={handleFormatChange} onClose={()=>setFormatOpen(false)}/>}
        {shareOpen&&<ShareModal code={sessionCode} status={liveStatus} liveUrl={liveUrl} snapshotUrl={snapshotUrl} onClose={()=>setShareOpen(false)} onRetry={startLive}/>}

        {/* Header */}
        <header className="relative border-b-[3px] border-[var(--ink)] overflow-hidden" style={{
          background:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 180' preserveAspectRatio='none'%3E%3Cg fill='%23FFFFFF'%3E%3Cellipse cx='170' cy='44' rx='72' ry='26'/%3E%3Cellipse cx='232' cy='36' rx='46' ry='22'/%3E%3Cellipse cx='1080' cy='50' rx='88' ry='32'/%3E%3Cellipse cx='1160' cy='38' rx='58' ry='24'/%3E%3C/g%3E%3C/svg%3E") no-repeat top/100%,linear-gradient(180deg,var(--sky-top) 0%,var(--sky-bot) 78%)`}}>
          <div className="h-3" style={{backgroundImage:"linear-gradient(45deg,#16233B 25%,transparent 25%),linear-gradient(-45deg,#16233B 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#16233B 75%),linear-gradient(-45deg,transparent 75%,#16233B 75%)",backgroundSize:"12px 12px",backgroundPosition:"0 0,0 6px,6px -6px,-6px 0",backgroundColor:"#FFF",borderBottom:"2.5px solid var(--ink)"}}/>
          <div className="relative z-10 max-w-[1360px] mx-auto px-4 py-3 flex flex-wrap gap-3 items-center justify-between">
            <div className="flex flex-col gap-2">
              <h1 className="font-[Luckiest_Guy,cursive] text-[clamp(20px,3.4vw,38px)] m-0 leading-none tracking-wide text-[var(--sun)]"
                style={{WebkitTextStroke:"2px var(--ink)",textShadow:"3px 3px 0 var(--ink)",transform:"rotate(-2deg)"}}>BEERIO KART</h1>
              <div className="font-[Fredoka] font-semibold text-[11.5px] tracking-wider text-[var(--ink)] bg-[var(--foam)] border-2 border-[var(--ink)] rounded-full px-2.5 py-1 inline-flex items-center gap-2 self-start shadow-[0_2px_0_rgba(22,35,59,.18)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--grass)] shadow-[0_0_0_1.5px_var(--ink)]"/>
                {isSpectator?(isLive?"📺 Live Spectator":"📺 Spectator View"):(sessionCode&&liveStatus==="live"?`🔴 LIVE · Room ${sessionCode}`:"🏎️ Double Elimination Night")}
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              {!isSpectator&&(
                <>
                  <button onClick={()=>{setShareOpen(true);startLive();}} title="Spectator view / QR"
                    className="w-9 h-9 rounded-[10px] border-2 border-[var(--ink)] bg-[var(--foam)] text-[var(--ink)] text-[15px] grid place-items-center shadow-[0_3px_0_rgba(22,35,59,.22)] hover:bg-white active:translate-y-px transition-all cursor-pointer flex-shrink-0" style={{touchAction:"manipulation"}}>📺</button>
                  <button onClick={()=>setFormatOpen(true)} title="Format"
                    className="w-9 h-9 rounded-[10px] border-2 border-[var(--ink)] bg-[var(--foam)] text-[var(--ink)] text-[15px] grid place-items-center shadow-[0_3px_0_rgba(22,35,59,.22)] hover:bg-white active:translate-y-px transition-all cursor-pointer flex-shrink-0" style={{touchAction:"manipulation"}}>⚙️</button>
                </>
              )}
              <button onClick={()=>setRulesOpen(true)} title="Rules"
                className="w-9 h-9 rounded-[10px] border-2 border-[var(--ink)] bg-[var(--foam)] text-[var(--ink)] text-[15px] grid place-items-center shadow-[0_3px_0_rgba(22,35,59,.22)] hover:bg-white active:translate-y-px transition-all cursor-pointer flex-shrink-0" style={{touchAction:"manipulation"}}>ℹ️</button>
              <div className="flex items-center gap-3.5 bg-[var(--foam)] border-2 border-[var(--ink)] rounded-[11px] px-3 py-2 shadow-[0_3px_0_rgba(22,35,59,.18)]">
                <BeerMug pct={pct}/>
                <div className="font-[Fredoka]">
                  <div className="text-[19px] font-bold text-[var(--ink)] leading-none">{done} / {total}</div>
                  <div className="text-[10px] text-[var(--ink-soft)] tracking-widest font-semibold mt-0.5">{isGP?"🏎️ Heats Run":"🍄 Heats Run"}</div>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Spectator banner */}
        {isSpectator&&(
          <div className="max-w-[1360px] mx-auto px-4 mt-3">
            <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--grape)] text-white border-2 border-[var(--ink)] rounded-[11px] px-4 py-2 shadow-[0_3px_0_rgba(22,35,59,.22)]">
              <span className="font-[Fredoka] font-semibold text-[12.5px] flex items-center gap-2">
                {isLive?(
                  <>
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{background:liveStatus==="live"?"#7CFFB0":"#FFC9C9"}}/>
                    {liveStatus==="error"?"Can't reach the host. The room may have ended.":liveStatus==="live"?"Watching live, updates automatically.":"Connecting to live room…"}
                  </>
                ):"📺 You're watching a shared snapshot, read only."}
              </span>
              <button onClick={editCopy} style={{touchAction:"manipulation"}}
                className="font-[Fredoka] font-bold text-[12px] bg-white text-[var(--ink)] border-2 border-[var(--ink)] rounded-[8px] px-3 py-1 shadow-[0_2px_0_rgba(22,35,59,.25)] active:translate-y-px cursor-pointer">Edit a copy</button>
            </div>
          </div>
        )}

        {/* Controls (hidden for spectators) */}
        {!isSpectator&&(
          <div className="max-w-[1360px] mx-auto px-4 py-3.5 flex flex-wrap gap-5 items-start">
            <div className="flex-1 min-w-[260px]">
              <div className="font-[Fredoka] font-bold text-[13.5px] text-[var(--ink)] mb-2 flex items-center gap-2.5 flex-wrap">
                <span>Racers</span>
                <span className="inline-flex items-center gap-1.5">
                  <button onClick={()=>handleSetCount(playerCount-1)} disabled={playerCount<=MIN_PLAYERS} style={{touchAction:"manipulation"}}
                    className="w-6 h-6 rounded-[6px] border-2 border-[var(--ink)] bg-[var(--sun)] text-[var(--ink)] font-bold text-base cursor-pointer grid place-items-center shadow-[0_2px_0_rgba(22,35,59,.26)] active:translate-y-px transition-all disabled:opacity-40 hover:bg-[var(--sun-deep)]">−</button>
                  <span className="font-bold text-[19px] text-[var(--ink)] min-w-[24px] text-center">{playerCount}</span>
                  <button onClick={()=>handleSetCount(playerCount+1)} disabled={playerCount>=MAX_PLAYERS} style={{touchAction:"manipulation"}}
                    className="w-6 h-6 rounded-[6px] border-2 border-[var(--ink)] bg-[var(--sun)] text-[var(--ink)] font-bold text-base cursor-pointer grid place-items-center shadow-[0_2px_0_rgba(22,35,59,.26)] active:translate-y-px transition-all disabled:opacity-40 hover:bg-[var(--sun-deep)]">+</button>
                  <span className="font-[Nunito] font-semibold text-[10px] text-[var(--muted)]">{capText}</span>
                  <span className="font-[Nunito] font-semibold text-[10px] text-[var(--ink)] bg-[var(--card2)] border border-[var(--ink)] rounded-full px-2 py-px">
                    {isGP?`grand prix · ${format.gpRaces} each`:`bracket · ${format.series===1?"single":format.series===2?"Bo3":"Bo5"}`}
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2">
                {names.map((name,i)=>(
                  <div key={i} className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 font-[Fredoka] font-bold text-[10.5px] text-[var(--ink)] bg-[var(--sun)] border border-[var(--ink)] w-[17px] h-[17px] rounded-[4px] grid place-items-center z-10">{i+1}</span>
                    <input type="text" value={name} onChange={e=>handleNameChange(i,e.target.value)}
                      placeholder={`Racer ${i+1}`} maxLength={18} autoComplete="off"
                      className="w-full pl-7 pr-2 py-1.5 bg-white border-2 border-[var(--ink)] rounded-[8px] text-[var(--ink)] font-[Nunito] text-[12.5px] font-bold outline-none shadow-[0_2px_0_rgba(22,35,59,.1)] focus:shadow-[0_0_0_2px_var(--sun),0_2px_0_rgba(22,35,59,.1)] placeholder:text-[#A9B2C2]"/>
                    {!name.trim()&&<span className="absolute right-1.5 top-1/2 -translate-y-1/2 font-[Fredoka] font-bold text-[8.5px] text-white bg-[var(--coral)] border border-[var(--ink)] rounded-[3px] px-1 py-px pointer-events-none">BYE</span>}
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-[var(--muted)] font-semibold leading-relaxed">Seed 1 is strongest. Empty slots are byes. Shuffle to randomize.</p>
            </div>
            <div className="flex flex-col gap-2 min-w-[152px]">
              {[{icon:"❓",label:"Shuffle seeds",onClick:handleShuffle,p:true},{icon:"↺",label:"Reset results",onClick:handleReset,p:false},{icon:"🧹",label:"Clear names",onClick:handleClearAll,p:false}].map(btn=>(
                <button key={btn.label} onClick={btn.onClick} style={{touchAction:"manipulation"}}
                  className={`font-[Fredoka] tracking-wide font-semibold text-[12.5px] cursor-pointer px-3 py-2 rounded-[9px] border-2 border-[var(--ink)] text-[var(--ink)] shadow-[0_3px_0_rgba(22,35,59,.22)] active:translate-y-[2px] active:shadow-[0_1px_0_rgba(22,35,59,.22)] transition-all text-left flex items-center gap-2 ${btn.p?"bg-[var(--sun)] hover:bg-[var(--sun-deep)]":"bg-white hover:bg-[#F5EFE0]"}`}>
                  <span>{btn.icon}</span>{btn.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Stage */}
        <div className="max-w-[1360px] mx-auto px-4 pb-12">
          {realCount<2?(
            <div className="mt-6 border-2 border-dashed border-[var(--ink)] rounded-[14px] p-10 text-center bg-[#FBF6EA]">
              <span className="text-4xl block mb-3">🏁</span>
              <h3 className="font-[Luckiest_Guy,cursive] text-[var(--ink)] text-xl tracking-wider m-0 mb-2">READY TO RACE?</h3>
              <p className="font-[Nunito] font-semibold text-[var(--muted)] text-[13px] m-0 leading-relaxed">Drop in at least two racer names above and {isGP?"start your Grand Prix.":"the bracket builds itself."}</p>
            </div>
          ):isGP?(
            <GrandPrix names={names} realCount={realCount} gpLog={gpLog} target={format.gpRaces}
              readOnly={isSpectator} onRecord={handleRecordRace} onUndo={handleUndoRace}/>
          ):(
            <>
              <BracketSection groups={wbGroups} M={M} onSlotClick={handleSlotClick}
                tagColor="var(--grass)" tagText="Winners Bracket" pipColor="var(--grass)"
                slotHFor={i=>wbSlotH(i+1)} rightConnFor={wbRightConn} rightPairFor={wbRightPair}
                seriesMap={series} format={format} readOnly={isSpectator} onReset={handleResetMatch}/>

              {lbGroups.length>0&&(
                <BracketSection groups={lbGroups} M={M} onSlotClick={handleSlotClick}
                  tagColor="var(--coral)" tagText="Losers Bracket" pipColor="var(--coral)"
                  slotHFor={i=>lbSlotH(i)} rightConnFor={lbRightConn} rightPairFor={lbRightPair}
                  seriesMap={series} format={format} readOnly={isSpectator} onReset={handleResetMatch}/>
              )}

              {/* Grand Final */}
              <section className="mt-5">
                <div className="flex items-center gap-3 mb-2.5">
                  <span className="w-3 h-3 border-2 border-[var(--ink)] rotate-45 rounded-sm" style={{background:"var(--grape)"}}/>
                  <span className="font-[Luckiest_Guy,cursive] text-[17px] tracking-wider text-white rounded-[9px] px-3 py-0.5 shadow-[0_3px_0_rgba(22,35,59,.22)]"
                    style={{background:"var(--grape)",border:"2px solid var(--ink)",transform:"rotate(-1deg)"}}>Grand Final</span>
                  <span className="h-[2px] bg-[var(--ink)] opacity-15 flex-1 rounded"/>
                </div>

                {gfBothKnown&&!champ&&(
                  <div className="mb-3 inline-flex items-center gap-0 border-2 border-[var(--ink)] rounded-[10px] overflow-hidden shadow-[0_2px_0_rgba(22,35,59,.18)]">
                    <div className={`flex items-center gap-2 px-3 py-1.5 ${gfScoreA>gfScoreB?"bg-[var(--sun)]":"bg-white"}`}>
                      <span className="font-[Fredoka] font-bold text-[12px] text-[var(--ink)] max-w-[110px] truncate">{gfA}</span>
                      <span className="font-[Luckiest_Guy,cursive] text-[20px] text-[var(--ink)] leading-none">{gfScoreA}</span>
                    </div>
                    <div className="w-px self-stretch bg-[var(--ink)]"/>
                    <div className="px-2 py-1.5 bg-[var(--grape)] flex flex-col items-center gap-0">
                      <span className="font-[Fredoka] font-bold text-[8px] text-white tracking-widest uppercase leading-none">First to</span>
                      <span className="font-[Luckiest_Guy,cursive] text-[13px] text-white leading-none">2</span>
                    </div>
                    <div className="w-px self-stretch bg-[var(--ink)]"/>
                    <div className={`flex items-center gap-2 px-3 py-1.5 ${gfScoreB>gfScoreA?"bg-[var(--sun)]":"bg-white"}`}>
                      <span className="font-[Luckiest_Guy,cursive] text-[20px] text-[var(--ink)] leading-none">{gfScoreB}</span>
                      <span className="font-[Fredoka] font-bold text-[12px] text-[var(--ink)] max-w-[110px] truncate">{gfB}</span>
                    </div>
                    <div className="w-px self-stretch bg-[var(--ink)]"/>
                    <div className="px-2 py-1.5 bg-[#F0F8FF]">
                      <span className="font-[Fredoka] font-bold text-[8.5px] text-[var(--ink)] tracking-wide leading-tight whitespace-nowrap">WB starts<br/>1–0</span>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-4 items-center">
                  <div className="flex flex-col gap-2" style={{width:CARD_W}}>
                    {gfMatches.map(id=>(
                      <MatchCard key={id} m={M[id]} onSlotClick={handleSlotClick} label={id==="GF"?"Game 1":"Reset · G2"}
                        seriesMap={series} format={format} readOnly={isSpectator} onReset={handleResetMatch}/>
                    ))}
                    {showReset&&<p className="font-[Nunito] text-[10.5px] font-bold text-[var(--grape-deep)] leading-snug">Lower-bracket forced a reset. One more game decides it.</p>}
                  </div>
                  {champ?(
                    <div className="flex-1 min-w-[220px] rounded-2xl border-[3px] border-[var(--ink)] flex flex-col items-center justify-center gap-3 px-8 py-8 text-center"
                      style={{background:"radial-gradient(130% 130% at 50% -10%,rgba(255,192,46,.7),rgba(255,192,46,0) 62%),var(--card2)",boxShadow:"0 6px 0 rgba(22,35,59,.22), 0 12px 32px rgba(22,35,59,.12)",animation:"champPop .4s cubic-bezier(.34,1.56,.64,1) both"}}>
                      <span style={{fontSize:52,lineHeight:1,filter:"drop-shadow(0 4px 0 rgba(22,35,59,.18))",animation:"champBounce 1.8s ease-in-out infinite"}}>🍻</span>
                      <div>
                        <div className="font-[Fredoka] tracking-[3px] text-[11px] text-[var(--sun-deep)] font-bold uppercase mb-1">🏆 Champion 🏆</div>
                        <div className="font-[Luckiest_Guy,cursive] text-[clamp(22px,4vw,34px)] text-[var(--ink)] leading-tight tracking-wide" style={{textShadow:"2px 2px 0 rgba(22,35,59,.1)"}}>{champ.name}</div>
                      </div>
                      <div className="font-[Fredoka] font-semibold text-[13px] text-[var(--ink-soft)]">Drinks are on the winner 🍺</div>
                    </div>
                  ):(
                    <div className="flex-1 min-w-[180px] max-w-[240px] rounded-xl border-2 border-dashed border-[var(--ink)] flex flex-col items-center justify-center gap-1.5 px-5 py-4 text-center bg-[#FBF6EA]">
                      <span className="text-3xl">🏁</span>
                      <span className="font-[Fredoka] tracking-[2px] text-[9.5px] text-[var(--sun-deep)] font-bold uppercase">Champion</span>
                      <span className="font-[Fredoka] font-semibold text-[var(--muted)] text-[13px]">To be crowned</span>
                    </div>
                  )}
                </div>
              </section>

              {/* Legend */}
              <div className="flex flex-wrap gap-3 mt-5 pt-3 border-t-2 border-dotted border-[#C9BFA8] font-[Nunito] text-[11px] font-bold text-[var(--ink-soft)]">
                {([
                  ["rgba(47,185,105,0.45)","var(--grass)","🍄 Winners"],
                  ["rgba(255,90,90,0.45)","var(--coral)","🐢 Losers"],
                  ["rgba(124,92,255,0.45)","var(--grape)","⭐ Grand Final"],
                ] as [string,string,string][]).map(([bg,border,l])=>(
                  <span key={l} className="flex items-center gap-1"><span className="w-3 h-3 rounded-[3px] border-2" style={{background:bg,borderColor:border}}/>{l}</span>
                ))}
                <span>{isSpectator?"📺 Read-only spectator view":"👉 Tap a racer to mark the heat winner. Tap again to undo."}</span>
              </div>
              <p className="mt-2 font-[Nunito] text-[11px] font-semibold text-[var(--muted)] leading-relaxed">
                🍌 Finish your drink before crossing the line. First loss → Losers. Second loss → you're out. WB champ starts the Grand Final one game up.
              </p>

              {/* Match history */}
              <MatchHistory BR={BR} M={M} series={series} groupTitleById={groupTitleById}/>
            </>
          )}
        </div>
      </div>
    </>
  );
}
