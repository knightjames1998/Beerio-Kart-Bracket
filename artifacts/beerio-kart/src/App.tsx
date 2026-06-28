import { useState, useCallback } from "react";

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

// ─── Layout constants ─────────────────────────────────────────────────────────
const CARD_H    = 98;   // px — height of one compact match card
const CARD_W    = 186;  // px — width of match card column
const SLOT_BASE = 106;  // px — base slot height = CARD_H + inter-card gap (8 px)
const CONN_W    = 14;   // px — width of each connector arm
const LINE_CLR  = "rgba(22,35,59,0.2)";

// WB round r (1-indexed):  slotH = SLOT_BASE * 2^(r-1)
// LB group i (0-indexed):  slotH = SLOT_BASE * 2^floor(i/2)
const wbSlotH = (r: number) => SLOT_BASE * Math.pow(2, r - 1);
const lbSlotH = (i: number) => SLOT_BASE * Math.pow(2, Math.floor(i / 2));

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_PLAYERS = 2, MAX_PLAYERS = 16, DEFAULT_COUNT = 8;
const ITEM_ICONS  = ["🍄","🍌","⭐","🐢","💥","🔥","🪙"];

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

// ─── Compact Match Card ───────────────────────────────────────────────────────

function SlotRow({m,slot,onClick}:{m:MatchResult;slot:"A"|"B";onClick:(id:string,s:"A"|"B")=>void}){
  const comp=slot==="A"?m.a:m.b;
  const isTbd=comp===TBD,isBye=comp===BYE,isPlayer=!isTbd&&!isBye;
  const player=isPlayer?(comp as Player):null;
  const isWin=m.decided&&!m.phantom&&m.winSlot===slot;
  const isLose=m.decided&&!m.phantom&&m.winSlot!==slot&&isPlayer;
  const clickable=isPlayer&&!m.auto;
  const lb=m.def.bracket==="lb",gf=m.def.bracket==="gf";
  let bg="#EDE8DC";
  if(isWin)bg=lb?"var(--coral)":gf?"var(--grape)":"var(--grass)";
  return(
    <button disabled={!clickable} onClick={()=>clickable&&onClick(m.def.id,slot)}
      style={{background:bg}}
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
      {isWin&&<span className="text-[9px] text-white leading-none">✔</span>}
    </button>
  );
}

function MatchCard({m,onSlotClick,label}:{m:MatchResult;onSlotClick:(id:string,s:"A"|"B")=>void;label?:string}){
  const icon=itemIconFor(m.def.id), lbl=label??matchLabel(m.def.id);
  return(
    <div style={{height:CARD_H}}
      className={["bg-white border border-[var(--ink)] rounded-[9px] p-1.5 flex flex-col justify-between",
        "shadow-[0_2px_0_rgba(22,35,59,.13)]",m.phantom?"opacity-40":""].join(" ")}>
      <div className="flex items-center justify-between gap-1">
        <span className="font-[Fredoka] font-bold text-[9.5px] tracking-wide text-[var(--ink)] bg-[#F5EFE0] border border-[var(--ink)] rounded-[3px] px-1 py-px leading-none">{lbl}</span>
        {m.def.drop&&<span className="font-[Nunito] text-[8.5px] font-bold text-[var(--muted)] leading-none truncate max-w-[78px]">{m.def.drop}</span>}
      </div>
      <SlotRow m={m} slot="A" onClick={onSlotClick}/>
      <div className="flex justify-center">
        <span className="font-[Fredoka] text-[8.5px] font-bold text-[var(--ink)] bg-[var(--sun)] border border-[var(--ink)] rounded-full px-1.5 leading-none py-px" style={{transform:"rotate(-2deg)"}}>{icon} vs</span>
      </div>
      <SlotRow m={m} slot="B" onClick={onSlotClick}/>
    </div>
  );
}

// ─── Bracket Column (slot-height layout + connector lines) ─────────────────────

interface ColProps {
  ids: string[];
  M: Record<string, MatchResult>;
  onSlotClick: (id: string, s: "A"|"B") => void;
  slotH: number;
  /** Whether to draw connector arms on the right toward the next round */
  rightConn: boolean;
  /** Whether right connectors include a vertical stem (pairing) */
  rightPair: boolean;
  /** Whether to draw a horizontal arm on the left (incoming from previous round) */
  leftConn: boolean;
  gfLabels?: Record<string,string>;
}

function BracketCol({ids,M,onSlotClick,slotH,rightConn,rightPair,leftConn,gfLabels}:ColProps){
  const totalH = ids.length * slotH;
  const totalW = CARD_W + (leftConn?CONN_W:0) + (rightConn?CONN_W:0);
  return(
    <div style={{position:"relative",width:totalW,height:totalH,flexShrink:0}}>
      {/* Cards */}
      {ids.map((id,i)=>{
        const cy=(i+0.5)*slotH;
        return(
          <div key={id} style={{position:"absolute",top:cy-CARD_H/2,left:leftConn?CONN_W:0,width:CARD_W}}>
            <MatchCard m={M[id]} onSlotClick={onSlotClick} label={gfLabels?.[id]}/>
          </div>
        );
      })}
      {/* Left arms */}
      {leftConn&&ids.map((_,i)=>{
        const cy=(i+0.5)*slotH;
        return <div key={i} style={{position:"absolute",left:0,top:cy-1,width:CONN_W,height:2,background:LINE_CLR}}/>;
      })}
      {/* Right arms */}
      {rightConn&&ids.map((_,i)=>{
        const cy=(i+0.5)*slotH;
        return <div key={i} style={{position:"absolute",right:0,top:cy-1,width:CONN_W,height:2,background:LINE_CLR}}/>;
      })}
      {/* Right vertical stems (pairing) */}
      {rightConn&&rightPair&&Array.from({length:Math.floor(ids.length/2)},(_,pi)=>{
        const topY=(2*pi+0.5)*slotH, botY=(2*pi+1.5)*slotH;
        return <div key={pi} style={{position:"absolute",right:0,top:topY,width:2,height:botY-topY,background:LINE_CLR}}/>;
      })}
    </div>
  );
}

// ─── Bracket Section ──────────────────────────────────────────────────────────

interface SectionProps {
  groups: BracketGroup[];
  M: Record<string,MatchResult>;
  onSlotClick: (id:string,s:"A"|"B")=>void;
  tagColor: string;
  tagText: string;
  pipColor: string;
  /** slotH calculator for each group index */
  slotHFor: (i:number)=>number;
  /** Should group i show right connectors? */
  rightConnFor: (i:number)=>boolean;
  /** Should right connectors be pairing (with vertical stem)? */
  rightPairFor: (i:number)=>boolean;
}

function BracketSection({groups,M,onSlotClick,tagColor,tagText,pipColor,slotHFor,rightConnFor,rightPairFor}:SectionProps){
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
                slotH={slotH} rightConn={right} rightPair={pair} leftConn={left}/>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Rules Modal ──────────────────────────────────────────────────────────────

const RULES = [
  {
    icon: "🚗",
    title: "No Drinking & Driving",
    body: "You CANNOT drink while actively racing. Seriously — put the can down, both hands on the wheel. You must finish your drink before or after the race, never during.",
  },
  {
    icon: "🍺",
    title: "Finish Before You Cross",
    body: "Your drink must be completely finished before you cross the finish line. If you cross with liquid still in the cup, your finish doesn't count — pull over and chug.",
  },
  {
    icon: "🏁",
    title: "Double Elimination",
    body: "Everyone gets a second chance. Your first loss drops you to the Losers Bracket. A second loss and you're done. The Losers Bracket champion earns their way back to the Grand Final.",
  },
  {
    icon: "⭐",
    title: "Grand Final — WB Advantage",
    body: "The Winners Bracket champion enters the Grand Final with a one-game lead. If they win Game 1, tournament over. If the Losers champ wins Game 1, scores reset to 0-0 and Game 2 decides everything.",
  },
  {
    icon: "🎮",
    title: "Track Selection",
    body: "Agree on tracks before each round or use random — no take-backs after the race starts. Recommend sticking to the same cup/track pool for the whole tournament.",
  },
  {
    icon: "🕐",
    title: "Timing",
    body: "Results are final the moment you cross the line with an empty cup. No mid-race disputes — settle them after the race is over.",
  },
  {
    icon: "🏠",
    title: "House Rules",
    body: "Add your own before the tournament starts. Common ones: item usage rules, rubber cup holders, the infamous Blue Shell fine (one extra sip). Whatever you agree on before race 1 is law.",
  },
];

function RulesModal({onClose}:{onClose:()=>void}){
  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{background:"rgba(22,35,59,0.6)",backdropFilter:"blur(4px)"}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="relative w-full max-w-lg max-h-[85vh] flex flex-col bg-[var(--foam)] border-[3px] border-[var(--ink)] rounded-[18px] shadow-[0_8px_0_rgba(22,35,59,.3)]"
        style={{overflowY:"auto"}}>
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[var(--sun)] border-b-[3px] border-[var(--ink)] px-5 py-3 flex items-center justify-between rounded-t-[15px]">
          <div>
            <h2 className="font-[Luckiest_Guy,cursive] text-[22px] text-[var(--ink)] leading-none tracking-wider m-0"
              style={{textShadow:"2px 2px 0 rgba(22,35,59,.15)"}}>
              🍺 BEERIO KART RULES
            </h2>
            <p className="font-[Fredoka] font-semibold text-[11px] text-[var(--ink)] opacity-70 mt-0.5 m-0 tracking-wide">
              Read before you race. Seriously.
            </p>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 rounded-[8px] border-2 border-[var(--ink)] bg-white text-[var(--ink)] font-bold text-lg grid place-items-center shadow-[0_2px_0_rgba(22,35,59,.22)] hover:bg-[#F5EFE0] active:translate-y-px transition-all cursor-pointer">
            ✕
          </button>
        </div>
        {/* Rules list */}
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
          <div className="mt-1 mb-1 bg-[#FFF1D8] border-2 border-[var(--sun-deep)] rounded-[12px] px-4 py-3 text-center">
            <p className="font-[Fredoka] font-bold text-[13px] text-[var(--ink)] m-0">
              🏎️ Most importantly: drink responsibly, have a designated driver, and don't actually drink and drive. Ever.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App(){
  const [playerCount,setPlayerCount]=useState(DEFAULT_COUNT);
  const [names,setNames]=useState<string[]>(Array(DEFAULT_COUNT).fill(""));
  const [results,setResults]=useState<Record<string,"A"|"B">>({});
  const [BR,setBR]=useState<Bracket>(()=>buildBracket(DEFAULT_COUNT));
  const [rulesOpen,setRulesOpen]=useState(false);

  const handleSetCount=useCallback((n:number)=>{
    const next=Math.max(MIN_PLAYERS,Math.min(MAX_PLAYERS,n));
    if(next===playerCount)return;
    setPlayerCount(next);
    setNames(prev=>{const a=[...prev];while(a.length<next)a.push("");return a.slice(0,next);});
    setResults({});setBR(buildBracket(next));
  },[playerCount]);

  const handleNameChange=useCallback((i:number,val:string)=>{
    setNames(prev=>{const a=[...prev];a[i]=val;return a;});
  },[]);

  const handleShuffle=useCallback(()=>{
    setNames(prev=>{
      const real=prev.map(n=>n.trim()).filter(Boolean);
      for(let i=real.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[real[i],real[j]]=[real[j],real[i]];}
      return prev.map((_,i)=>real[i]||"");
    });setResults({});
  },[]);

  const handleReset=useCallback(()=>setResults({}),[]);
  const handleClearAll=useCallback(()=>{setNames(Array(playerCount).fill(""));setResults({});},[playerCount]);

  const handleSlotClick=useCallback((matchId:string,slot:"A"|"B")=>{
    setResults(prev=>{
      const next={...prev};
      if(next[matchId]===slot)delete next[matchId];else next[matchId]=slot;
      let changed=true;
      while(changed){
        changed=false;const M=compute(BR,names,next);
        for(const id in next){
          const m=M[id];if(!m){delete next[id];changed=true;continue;}
          if(!(m.a!==TBD&&m.a!==BYE&&m.b!==TBD&&m.b!==BYE)){delete next[id];changed=true;}
        }
      }
      return next;
    });
  },[BR,names]);

  const M=compute(BR,names,results);
  const champ=getChampion(M);
  const realCount=names.filter(n=>n&&n.trim()).length;

  let done=0,playable=0;
  for(const id in M){
    const m=M[id];if(!m.active)continue;
    const aR=m.a!==TBD&&m.a!==BYE,bR=m.b!==TBD&&m.b!==BYE;
    if(aR&&bR&&!m.auto){playable++;if(m.decided)done++;}
  }
  const pct=playable?Math.round(done/playable*100):0;
  const S=nextPow2(playerCount),byes=S-playerCount;
  const capText=byes>0?`${byes} bye${byes>1?"s":""}→${S}-slot`:`clean ${S}-slot`;

  const wbGroups=BR.groups.filter(g=>g.bracket==="wb");
  const lbGroups=BR.groups.filter(g=>g.bracket==="lb");
  const gfMatches=M["GF2"]&&M["GF2"].active?["GF","GF2"]:["GF"];
  const showReset=M["GF"]?.decided&&M["GF"]?.winSlot==="B"&&!(M["GF2"]?.decided);

  // WB connector rules:
  // All WB rounds except last have right connectors with pairing
  const wbRightConn=(i:number)=>i<wbGroups.length-1;
  const wbRightPair=(_i:number)=>true;

  // LB connector rules:
  // LB groups: 0=minor, 1=major, 2=minor, 3=major, ...
  // Right connectors with pairing on odd-indexed groups (major) that precede a minor group
  const lbRightConn=(i:number)=>i%2===1&&i<lbGroups.length-1;
  const lbRightPair=(_i:number)=>true;

  return(
    <div className="min-h-screen">
      {rulesOpen&&<RulesModal onClose={()=>setRulesOpen(false)}/>}
      {/* Header */}
      <header className="relative border-b-[3px] border-[var(--ink)] overflow-hidden" style={{
        background:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 180' preserveAspectRatio='none'%3E%3Cg fill='%23FFFFFF'%3E%3Cellipse cx='170' cy='44' rx='72' ry='26'/%3E%3Cellipse cx='232' cy='36' rx='46' ry='22'/%3E%3Cellipse cx='1080' cy='50' rx='88' ry='32'/%3E%3Cellipse cx='1160' cy='38' rx='58' ry='24'/%3E%3C/g%3E%3C/svg%3E") no-repeat top/100%,linear-gradient(180deg,var(--sky-top) 0%,var(--sky-bot) 78%)`}}>
        <div className="h-3" style={{backgroundImage:"linear-gradient(45deg,#16233B 25%,transparent 25%),linear-gradient(-45deg,#16233B 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#16233B 75%),linear-gradient(-45deg,transparent 75%,#16233B 75%)",backgroundSize:"12px 12px",backgroundPosition:"0 0,0 6px,6px -6px,-6px 0",backgroundColor:"#FFF",borderBottom:"2.5px solid var(--ink)"}}/>
        <div className="relative z-10 max-w-[1360px] mx-auto px-4 py-3 flex flex-wrap gap-3 items-center justify-between">
          <div className="flex flex-col gap-2">
            <h1 className="font-[Luckiest_Guy,cursive] text-[clamp(20px,3.4vw,38px)] m-0 leading-none tracking-wide text-[var(--sun)]"
              style={{WebkitTextStroke:"2px var(--ink)",textShadow:"3px 3px 0 var(--ink)",transform:"rotate(-2deg)"}}>
              BEERIO KART
            </h1>
            <div className="font-[Fredoka] font-semibold text-[11.5px] tracking-wider text-[var(--ink)] bg-[var(--foam)] border-2 border-[var(--ink)] rounded-full px-2.5 py-1 inline-flex items-center gap-2 self-start shadow-[0_2px_0_rgba(22,35,59,.18)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--grass)] shadow-[0_0_0_1.5px_var(--ink)]"/>
              🏎️ Double Elimination Night
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={()=>setRulesOpen(true)}
              title="Rules"
              className="w-9 h-9 rounded-[10px] border-2 border-[var(--ink)] bg-[var(--foam)] text-[var(--ink)] font-[Fredoka] font-bold text-[15px] grid place-items-center shadow-[0_3px_0_rgba(22,35,59,.22)] hover:bg-white active:translate-y-px transition-all cursor-pointer flex-shrink-0">
              ℹ️
            </button>
          <div className="flex items-center gap-3.5 bg-[var(--foam)] border-2 border-[var(--ink)] rounded-[11px] px-3 py-2 shadow-[0_3px_0_rgba(22,35,59,.18)]">
            <div className="relative w-10 h-[54px] border-2 border-[var(--ink)] rounded-[6px_6px_9px_9px] bg-white/60 overflow-hidden flex-shrink-0">
              <div className="absolute left-0 right-0 bottom-0 bg-gradient-to-b from-[var(--sun)] to-[var(--sun-deep)] transition-all duration-500" style={{height:pct+"%"}}/>
              <div className="absolute left-0 right-0 h-[7px] bg-[var(--foam)] rounded-[50%_50%_0_0/100%_100%_0_0] transition-all duration-500" style={{bottom:pct+"%"}}/>
              <div className="absolute -right-[11px] top-[9px] w-[11px] h-[24px] border-2 border-[var(--ink)] border-l-0 rounded-[0_8px_8px_0]"/>
            </div>
            <div className="font-[Fredoka]">
              <div className="text-[19px] font-bold text-[var(--ink)] leading-none">{done} / {playable}</div>
              <div className="text-[10px] text-[var(--ink-soft)] tracking-widest font-semibold mt-0.5">🍄 Heats Run</div>
            </div>
          </div>
          </div>
        </div>
      </header>

      {/* Controls */}
      <div className="max-w-[1360px] mx-auto px-4 py-3.5 flex flex-wrap gap-5 items-start">
        <div className="flex-1 min-w-[260px]">
          <div className="font-[Fredoka] font-bold text-[13.5px] text-[var(--ink)] mb-2 flex items-center gap-2.5 flex-wrap">
            <span>Racers</span>
            <span className="inline-flex items-center gap-1.5">
              <button onClick={()=>handleSetCount(playerCount-1)} disabled={playerCount<=MIN_PLAYERS}
                className="w-6 h-6 rounded-[6px] border-2 border-[var(--ink)] bg-[var(--sun)] text-[var(--ink)] font-bold text-base cursor-pointer grid place-items-center shadow-[0_2px_0_rgba(22,35,59,.26)] active:translate-y-px transition-all disabled:opacity-40 hover:bg-[var(--sun-deep)]">−</button>
              <span className="font-bold text-[19px] text-[var(--ink)] min-w-[24px] text-center">{playerCount}</span>
              <button onClick={()=>handleSetCount(playerCount+1)} disabled={playerCount>=MAX_PLAYERS}
                className="w-6 h-6 rounded-[6px] border-2 border-[var(--ink)] bg-[var(--sun)] text-[var(--ink)] font-bold text-base cursor-pointer grid place-items-center shadow-[0_2px_0_rgba(22,35,59,.26)] active:translate-y-px transition-all disabled:opacity-40 hover:bg-[var(--sun-deep)]">+</button>
              <span className="font-[Nunito] font-semibold text-[10px] text-[var(--muted)]">{capText}</span>
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
            <button key={btn.label} onClick={btn.onClick}
              className={`font-[Fredoka] tracking-wide font-semibold text-[12.5px] cursor-pointer px-3 py-2 rounded-[9px] border-2 border-[var(--ink)] text-[var(--ink)] shadow-[0_3px_0_rgba(22,35,59,.22)] active:translate-y-[2px] active:shadow-[0_1px_0_rgba(22,35,59,.22)] transition-all text-left flex items-center gap-2 ${btn.p?"bg-[var(--sun)] hover:bg-[var(--sun-deep)]":"bg-white hover:bg-[#F5EFE0]"}`}>
              <span>{btn.icon}</span>{btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stage */}
      <div className="max-w-[1360px] mx-auto px-4 pb-12">
        {realCount<2?(
          <div className="mt-6 border-2 border-dashed border-[var(--ink)] rounded-[14px] p-10 text-center bg-[#FBF6EA]">
            <span className="text-4xl block mb-3">🏁</span>
            <h3 className="font-[Luckiest_Guy,cursive] text-[var(--ink)] text-xl tracking-wider m-0 mb-2">READY TO RACE?</h3>
            <p className="font-[Nunito] font-semibold text-[var(--muted)] text-[13px] m-0 leading-relaxed">Drop in at least two racer names above — the bracket builds itself.</p>
          </div>
        ):(
          <>
            <BracketSection groups={wbGroups} M={M} onSlotClick={handleSlotClick}
              tagColor="var(--grass)" tagText="Winners Bracket" pipColor="var(--grass)"
              slotHFor={i=>wbSlotH(i+1)}
              rightConnFor={wbRightConn} rightPairFor={wbRightPair}/>

            {lbGroups.length>0&&(
              <BracketSection groups={lbGroups} M={M} onSlotClick={handleSlotClick}
                tagColor="var(--coral)" tagText="Losers Bracket" pipColor="var(--coral)"
                slotHFor={i=>lbSlotH(i)}
                rightConnFor={lbRightConn} rightPairFor={lbRightPair}/>
            )}

            {/* Grand Final */}
            <section className="mt-5">
              <div className="flex items-center gap-3 mb-2.5">
                <span className="w-3 h-3 border-2 border-[var(--ink)] rotate-45 rounded-sm" style={{background:"var(--grape)"}}/>
                <span className="font-[Luckiest_Guy,cursive] text-[17px] tracking-wider text-white rounded-[9px] px-3 py-0.5 shadow-[0_3px_0_rgba(22,35,59,.22)]"
                  style={{background:"var(--grape)",border:"2px solid var(--ink)",transform:"rotate(-1deg)"}}>Grand Final</span>
                <span className="h-[2px] bg-[var(--ink)] opacity-15 flex-1 rounded"/>
              </div>
              <div className="flex flex-wrap gap-4 items-center">
                <div className="flex flex-col gap-2" style={{width:CARD_W}}>
                  {gfMatches.map(id=>(
                    <MatchCard key={id} m={M[id]} onSlotClick={handleSlotClick} label={id==="GF"?"Game 1":"Reset · G2"}/>
                  ))}
                  {showReset&&<p className="font-[Nunito] text-[10.5px] font-bold text-[var(--grape-deep)] leading-snug">Lower-bracket forced a reset — one more game decides it.</p>}
                </div>
                {champ ? (
                  /* ── Big winner card ── */
                  <div className="flex-1 min-w-[220px] rounded-2xl border-[3px] border-[var(--ink)] flex flex-col items-center justify-center gap-3 px-8 py-8 text-center"
                    style={{
                      background:"radial-gradient(130% 130% at 50% -10%,rgba(255,192,46,.7),rgba(255,192,46,0) 62%),var(--card2)",
                      boxShadow:"0 6px 0 rgba(22,35,59,.22), 0 12px 32px rgba(22,35,59,.12)",
                      animation:"champPop .4s cubic-bezier(.34,1.56,.64,1) both",
                    }}>
                    <span style={{fontSize:52,lineHeight:1,filter:"drop-shadow(0 4px 0 rgba(22,35,59,.18))",animation:"champBounce 1.8s ease-in-out infinite"}}>🍻</span>
                    <div>
                      <div className="font-[Fredoka] tracking-[3px] text-[11px] text-[var(--sun-deep)] font-bold uppercase mb-1">🏆 Champion 🏆</div>
                      <div className="font-[Luckiest_Guy,cursive] text-[clamp(22px,4vw,34px)] text-[var(--ink)] leading-tight tracking-wide" style={{textShadow:"2px 2px 0 rgba(22,35,59,.1)"}}>
                        {champ.name}
                      </div>
                    </div>
                    <div className="font-[Fredoka] font-semibold text-[13px] text-[var(--ink-soft)]">
                      Drinks are on the winner 🍺
                    </div>
                  </div>
                ) : (
                  /* ── Waiting card ── */
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
              {[["var(--grass)","🍄 Winners"],["var(--coral)","🐢 Losers"],["var(--grape)","⭐ Grand Final"]].map(([c,l])=>(
                <span key={l} className="flex items-center gap-1"><span className="w-3 h-3 rounded-[3px] border border-[var(--ink)]" style={{background:c+"66"}}/>{l}</span>
              ))}
              <span>👉 Tap a racer to mark the heat winner. Tap again to undo.</span>
            </div>
            <p className="mt-2 font-[Nunito] text-[11px] font-semibold text-[var(--muted)] leading-relaxed">
              🍌 Finish your drink before crossing the line. First loss → Losers. Second loss → you're out. WB champ starts Grand Final one game up.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
