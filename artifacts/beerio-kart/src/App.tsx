import { useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type SlotSeed = { t: "seed"; n: number };
type SlotWin = { t: "win"; m: string };
type SlotLose = { t: "lose"; m: string };
type SlotSource = SlotSeed | SlotWin | SlotLose;

interface MatchDef {
  id: string;
  grp: string;
  bracket: "wb" | "lb" | "gf";
  drop?: string;
  a: SlotSource;
  b: SlotSource;
}

interface BracketGroup {
  key: string;
  title: string;
  bracket: "wb" | "lb" | "gf";
  ids: string[];
}

interface Bracket {
  defs: MatchDef[];
  byId: Record<string, MatchDef>;
  groups: BracketGroup[];
  k: number;
  S: number;
}

interface Player {
  seed: number;
  name: string | null;
}

const TBD: unique symbol = Symbol("TBD");
const BYE: { bye: true; name: "BYE"; seed?: undefined } = { bye: true, name: "BYE" };
type TBDType = typeof TBD;
type BYEType = typeof BYE;
type Competitor = Player | TBDType | BYEType;

interface MatchResult {
  a: Competitor;
  b: Competitor;
  winner: Competitor;
  loser: Competitor;
  decided: boolean;
  winSlot: "A" | "B" | null;
  auto: boolean;
  phantom: boolean;
  active: boolean;
  def: MatchDef;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 16;
const DEFAULT_COUNT = 8;
const ITEM_ICONS = ["🍄", "🍌", "⭐", "🐢", "💥", "🔥", "🪙"];

// ─── Bracket Engine ───────────────────────────────────────────────────────────

function nextPow2(n: number): number {
  let s = 1;
  while (s < n) s *= 2;
  return Math.max(2, s);
}

function seedOrder(S: number): number[] {
  let pls = [1, 2];
  const rounds = Math.log2(S);
  for (let r = 0; r < rounds - 1; r++) {
    const len = pls.length * 2 + 1;
    const out: number[] = [];
    for (const d of pls) { out.push(d); out.push(len - d); }
    pls = out;
  }
  return pls;
}

function roundTitleW(r: number, k: number): string {
  if (r === k) return "Winners Final";
  if (r === k - 1) return "Winners Semis";
  return "Round " + r;
}

function roundTitleL(r: number, last: number): string {
  if (r === last) return "Losers Final";
  if (r === last - 1) return "Losers Semis";
  return "Losers Round " + r;
}

function buildBracket(N: number): Bracket {
  const S = nextPow2(N);
  const k = Math.log2(S);
  const defs: MatchDef[] = [];
  const groups: BracketGroup[] = [];
  const wbRounds: Record<number, string[]> = {};

  const lbRoundForWB: Record<number, number> = { 1: 1 };
  for (let r = 2; r <= k; r++) lbRoundForWB[r] = 2 * r - 2;
  const lastLB = 2 * k - 2;

  const order = seedOrder(S);

  // WR1
  const ids1: string[] = [];
  for (let i = 0; i < S / 2; i++) {
    const id = `W1M${i}`;
    const drop = lbRoundForWB[1] === lastLB ? "L → Losers Final" : `L → Losers R${lbRoundForWB[1]}`;
    defs.push({ id, grp: "W1", bracket: "wb", drop, a: { t: "seed", n: order[2 * i] }, b: { t: "seed", n: order[2 * i + 1] } });
    ids1.push(id);
  }
  wbRounds[1] = ids1;
  groups.push({ key: "W1", title: roundTitleW(1, k), bracket: "wb", ids: ids1 });

  for (let r = 2; r <= k; r++) {
    const ids: string[] = [];
    const cnt = S / Math.pow(2, r);
    const prev = wbRounds[r - 1];
    const drop = lbRoundForWB[r] === lastLB ? "L → Losers Final" : `L → Losers R${lbRoundForWB[r]}`;
    for (let i = 0; i < cnt; i++) {
      const id = `W${r}M${i}`;
      defs.push({ id, grp: `W${r}`, bracket: "wb", drop, a: { t: "win", m: prev[2 * i] }, b: { t: "win", m: prev[2 * i + 1] } });
      ids.push(id);
    }
    wbRounds[r] = ids;
    groups.push({ key: `W${r}`, title: roundTitleW(r, k), bracket: "wb", ids });
  }

  // Losers bracket
  let lbFinalId: string | null = null;
  if (k >= 2) {
    let lr = 1;
    {
      const ids: string[] = [];
      const cnt = S / 4;
      for (let i = 0; i < cnt; i++) {
        const id = `L${lr}M${i}`;
        defs.push({ id, grp: `L${lr}`, bracket: "lb", a: { t: "lose", m: ids1[2 * i] }, b: { t: "lose", m: ids1[2 * i + 1] } });
        ids.push(id);
      }
      groups.push({ key: `L${lr}`, title: roundTitleL(lr, lastLB), bracket: "lb", ids });
      var prevL = ids; lr++;
    }
    for (let j = 1; j <= k - 1; j++) {
      const wbLosers = wbRounds[j + 1];
      const cnt = prevL.length;
      const idsMaj: string[] = [];
      for (let i = 0; i < cnt; i++) {
        const id = `L${lr}M${i}`;
        const wbIdx = cnt - 1 - i;
        defs.push({ id, grp: `L${lr}`, bracket: "lb", a: { t: "win", m: prevL[i] }, b: { t: "lose", m: wbLosers[wbIdx] } });
        idsMaj.push(id);
      }
      groups.push({ key: `L${lr}`, title: roundTitleL(lr, lastLB), bracket: "lb", ids: idsMaj });
      prevL = idsMaj; lr++;
      if (j < k - 1) {
        const cnt2 = prevL.length / 2;
        const idsMin: string[] = [];
        for (let i = 0; i < cnt2; i++) {
          const id = `L${lr}M${i}`;
          defs.push({ id, grp: `L${lr}`, bracket: "lb", a: { t: "win", m: prevL[2 * i] }, b: { t: "win", m: prevL[2 * i + 1] } });
          idsMin.push(id);
        }
        groups.push({ key: `L${lr}`, title: roundTitleL(lr, lastLB), bracket: "lb", ids: idsMin });
        prevL = idsMin; lr++;
      }
    }
    lbFinalId = prevL[0];
  }

  const wbFinalId = wbRounds[k][0];
  const gfB: SlotSource = k >= 2 ? { t: "win", m: lbFinalId! } : { t: "lose", m: wbFinalId };

  if (k < 2) {
    const d = defs.find(x => x.id === wbFinalId);
    if (d) d.drop = "L → Grand Final";
  }

  defs.push({ id: "GF", grp: "GF", bracket: "gf", a: { t: "win", m: wbFinalId }, b: gfB });
  defs.push({ id: "GF2", grp: "GF", bracket: "gf", a: { t: "win", m: wbFinalId }, b: gfB });
  groups.push({ key: "GF", title: "Grand Final", bracket: "gf", ids: ["GF", "GF2"] });

  const byId = Object.fromEntries(defs.map(d => [d.id, d]));
  return { defs, byId, groups, k, S };
}

function compute(BR: Bracket, names: string[], results: Record<string, "A" | "B">): Record<string, MatchResult> {
  const players: Player[] = names.map((n, i) => ({ seed: i + 1, name: n && n.trim() ? n.trim() : null }));
  const M: Record<string, MatchResult> = {};

  const resolve = (src: SlotSource): Competitor => {
    if (src.t === "seed") {
      const p = players[src.n - 1];
      return !p || p.name === null ? BYE : p;
    }
    const m = M[src.m];
    if (!m || !m.decided) return TBD;
    return src.t === "win" ? m.winner : m.loser;
  };

  for (const def of BR.defs) {
    if (def.id === "GF2") {
      const gf = M["GF"];
      const need = gf && gf.decided && gf.winSlot === "B";
      if (!need) {
        M.GF2 = { a: TBD, b: TBD, winner: TBD, loser: TBD, decided: false, winSlot: null, auto: false, phantom: false, active: false, def };
        continue;
      }
    }

    const a = resolve(def.a);
    const b = resolve(def.b);
    const aReal = a !== TBD && a !== BYE;
    const bReal = b !== TBD && b !== BYE;

    let winner: Competitor = TBD, loser: Competitor = TBD;
    let decided = false, winSlot: "A" | "B" | null = null, auto = false, phantom = false;

    if (a === BYE && bReal) { winner = b; loser = BYE; decided = true; winSlot = "B"; auto = true; }
    else if (b === BYE && aReal) { winner = a; loser = BYE; decided = true; winSlot = "A"; auto = true; }
    else if (a === BYE && b === BYE) { winner = BYE; loser = BYE; decided = true; winSlot = "A"; auto = true; phantom = true; }
    else if (aReal && bReal) {
      const r = results[def.id];
      if (r === "A") { winner = a; loser = b; decided = true; winSlot = "A"; }
      else if (r === "B") { winner = b; loser = a; decided = true; winSlot = "B"; }
    }

    M[def.id] = { a, b, winner, loser, decided, winSlot, auto, phantom, active: true, def };
  }

  return M;
}

function getChampion(M: Record<string, MatchResult>): Player | null {
  const isReal = (p: Competitor): p is Player => p !== TBD && p !== BYE;
  const gf = M["GF"], gf2 = M["GF2"];
  if (gf && gf.decided && isReal(gf.winner)) {
    if (gf.winSlot === "A") return gf.winner;
    if (gf2 && gf2.decided && isReal(gf2.winner)) return gf2.winner;
  }
  return null;
}

function itemIconFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ITEM_ICONS[h % ITEM_ICONS.length];
}

function matchLabel(id: string): string {
  const mm = id.match(/^([WL])(\d+)M(\d+)$/);
  if (mm) return `${mm[1]}${mm[2]}·${parseInt(mm[3]) + 1}`;
  return id;
}

// ─── Components ───────────────────────────────────────────────────────────────

interface SlotButtonProps {
  m: MatchResult;
  slot: "A" | "B";
  onClick: (matchId: string, slot: "A" | "B") => void;
}

function SlotButton({ m, slot, onClick }: SlotButtonProps) {
  const comp = slot === "A" ? m.a : m.b;
  const isTbd = comp === TBD;
  const isBye = comp === BYE;
  const isPlayer = !isTbd && !isBye;
  const player = isPlayer ? (comp as Player) : null;

  const isWin = m.decided && !m.phantom && m.winSlot === slot;
  const isLose = m.decided && !m.phantom && m.winSlot !== slot && isPlayer;
  const clickable = isPlayer && !m.auto;

  const bracketIsLb = m.def.bracket === "lb";
  const bracketIsGf = m.def.bracket === "gf";

  let bgClass = "bg-[#F4F0E6]";
  if (isWin) {
    if (bracketIsLb) bgClass = "bg-[var(--coral)]";
    else if (bracketIsGf) bgClass = "bg-[var(--grape)]";
    else bgClass = "bg-[var(--grass)]";
  }

  return (
    <button
      disabled={!clickable}
      onClick={() => clickable && onClick(m.def.id, slot)}
      className={`
        w-full flex items-center gap-2 px-3 py-2.5 rounded-[9px] border-2 border-[var(--ink)]
        font-[Nunito] text-sm font-bold text-left transition-all duration-100
        ${bgClass}
        ${isWin ? "text-white shadow-[0_3px_0_rgba(0,0,0,0.3)]" : ""}
        ${isLose ? "opacity-55" : ""}
        ${isTbd ? "border-dashed text-[#A4AEBF] cursor-default italic" : ""}
        ${isBye ? "text-[#9AA4B5] cursor-default" : ""}
        ${clickable ? "hover:bg-white hover:-translate-y-px hover:shadow-[0_3px_0_rgba(22,35,59,.18)] active:translate-y-0 cursor-pointer" : "cursor-default"}
      `}
      style={!clickable ? { boxShadow: "none" } : undefined}
    >
      <span
        className={`inline-grid place-items-center min-w-[19px] h-[19px] rounded-[5px] text-[11px] font-bold font-[Fredoka]
          ${isWin ? "bg-black/20 text-white" : "bg-[var(--ink-soft)] text-white"}
          ${isTbd || isBye ? "bg-[#C3CAD6]" : ""}
        `}
      >
        {isTbd || isBye ? "·" : player?.seed}
      </span>
      <span className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${isLose ? "line-through decoration-[var(--coral)] decoration-2" : ""}`}>
        {isTbd ? "Waiting…" : isBye ? "Bye" : player?.name}
      </span>
      {isWin && <span className="text-white text-sm">✔</span>}
    </button>
  );
}

interface MatchCardProps {
  m: MatchResult;
  onSlotClick: (matchId: string, slot: "A" | "B") => void;
  gfLabel?: string;
}

function MatchCard({ m, onSlotClick, gfLabel }: MatchCardProps) {
  const icon = itemIconFor(m.def.id);
  const label = gfLabel ?? matchLabel(m.def.id);

  return (
    <div className={`bg-white border-2 border-[var(--ink)] rounded-[14px] p-2.5 shadow-[0_4px_0_rgba(22,35,59,.16),0_7px_16px_rgba(22,35,59,.08)] ${m.phantom ? "opacity-40" : ""}`}>
      <div className="flex justify-between items-center mb-2 gap-1.5">
        <span className="font-[Fredoka] font-bold text-[11px] tracking-wide text-[var(--ink)] bg-[var(--card2)] border-2 border-[var(--ink)] rounded-[6px] px-1.5 py-px">
          {label}
        </span>
        {m.def.drop && (
          <span className="font-[Nunito] text-[10px] font-bold text-[var(--muted)]">{m.def.drop}</span>
        )}
      </div>
      <SlotButton m={m} slot="A" onClick={onSlotClick} />
      <div className="my-1.5 flex justify-center">
        <span
          className="font-[Fredoka] text-[11px] tracking-widest font-bold text-[var(--ink)] uppercase bg-[var(--sun)] border-2 border-[var(--ink)] rounded-full px-2.5 py-px"
          style={{ transform: "rotate(-2deg)" }}
        >
          {icon} vs
        </span>
      </div>
      <SlotButton m={m} slot="B" onClick={onSlotClick} />
    </div>
  );
}

interface RoundColumnProps {
  group: BracketGroup;
  M: Record<string, MatchResult>;
  onSlotClick: (matchId: string, slot: "A" | "B") => void;
}

function RoundColumn({ group, M, onSlotClick }: RoundColumnProps) {
  return (
    <div className="min-w-[214px] flex-none flex flex-col gap-3.5">
      <div className="font-[Fredoka] tracking-wide text-[12.5px] font-bold text-[var(--ink-soft)] pb-2 border-b-2 border-dotted border-[#C9BFA8]">
        {group.title}
      </div>
      <div className="flex flex-col gap-3.5 justify-around flex-1">
        {group.ids.map(id => (
          M[id] && <MatchCard key={id} m={M[id]} onSlotClick={onSlotClick} />
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function App() {
  const [playerCount, setPlayerCount] = useState(DEFAULT_COUNT);
  const [names, setNames] = useState<string[]>(Array(DEFAULT_COUNT).fill(""));
  const [results, setResults] = useState<Record<string, "A" | "B">>({});
  const [BR, setBR] = useState<Bracket>(() => buildBracket(DEFAULT_COUNT));

  const handleSetCount = useCallback((n: number) => {
    const next = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
    if (next === playerCount) return;
    setPlayerCount(next);
    setNames(prev => {
      const arr = [...prev];
      while (arr.length < next) arr.push("");
      return arr.slice(0, next);
    });
    setResults({});
    setBR(buildBracket(next));
  }, [playerCount]);

  const handleNameChange = useCallback((i: number, val: string) => {
    setNames(prev => { const a = [...prev]; a[i] = val; return a; });
  }, []);

  const handleShuffle = useCallback(() => {
    setNames(prev => {
      const real = prev.map(n => n.trim()).filter(Boolean);
      for (let i = real.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [real[i], real[j]] = [real[j], real[i]];
      }
      return prev.map((_, i) => real[i] || "");
    });
    setResults({});
  }, []);

  const handleReset = useCallback(() => setResults({}), []);

  const handleClearAll = useCallback(() => {
    setNames(Array(playerCount).fill(""));
    setResults({});
  }, [playerCount]);

  const handleSlotClick = useCallback((matchId: string, slot: "A" | "B") => {
    setResults(prev => {
      const next = { ...prev };
      if (next[matchId] === slot) delete next[matchId];
      else next[matchId] = slot;

      // Prune downstream
      let changed = true;
      while (changed) {
        changed = false;
        const M = compute(BR, names, next);
        for (const id in next) {
          const m = M[id];
          if (!m) { delete next[id]; changed = true; continue; }
          const aReal = m.a !== TBD && m.a !== BYE;
          const bReal = m.b !== TBD && m.b !== BYE;
          if (!(aReal && bReal)) { delete next[id]; changed = true; }
        }
      }
      return next;
    });
  }, [BR, names]);

  const M = compute(BR, names, results);
  const champ = getChampion(M);
  const realCount = names.filter(n => n && n.trim()).length;

  // Progress
  let done = 0, playable = 0;
  for (const id in M) {
    const m = M[id];
    if (!m.active) continue;
    const aReal = m.a !== TBD && m.a !== BYE;
    const bReal = m.b !== TBD && m.b !== BYE;
    if (aReal && bReal && !m.auto) { playable++; if (m.decided) done++; }
  }
  const pct = playable ? Math.round(done / playable * 100) : 0;

  const wbGroups = BR.groups.filter(g => g.bracket === "wb");
  const lbGroups = BR.groups.filter(g => g.bracket === "lb");

  // Byes info
  const S = nextPow2(playerCount);
  const byes = S - playerCount;
  const capText = byes > 0
    ? `${byes} bye${byes > 1 ? "s" : ""} → ${S}-slot bracket`
    : `clean ${S}-slot bracket`;

  // GF
  const gfMatches = M["GF2"] && M["GF2"].active ? ["GF", "GF2"] : ["GF"];
  const showReset = M["GF"]?.decided && M["GF"]?.winSlot === "B" && !(M["GF2"]?.decided);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="relative border-b-4 border-[var(--ink)] overflow-hidden" style={{
        background: `
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 240' preserveAspectRatio='none'%3E%3Cg fill='%23FFFFFF'%3E%3Cellipse cx='170' cy='50' rx='72' ry='26'/%3E%3Cellipse cx='232' cy='42' rx='46' ry='22'/%3E%3Cellipse cx='120' cy='44' rx='40' ry='18'/%3E%3Cellipse cx='1080' cy='55' rx='88' ry='32'/%3E%3Cellipse cx='1160' cy='44' rx='58' ry='24'/%3E%3Cellipse cx='1020' cy='48' rx='46' ry='20'/%3E%3C/g%3E%3C/svg%3E") no-repeat top/100%,
          linear-gradient(180deg, var(--sky-top) 0%, var(--sky-bot) 78%)
        `
      }}>
        <div className="h-4" style={{
          backgroundImage: "linear-gradient(45deg,#16233B 25%,transparent 25%),linear-gradient(-45deg,#16233B 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#16233B 75%),linear-gradient(-45deg,transparent 75%,#16233B 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
          backgroundColor: "#FFFFFF",
          borderBottom: "3px solid var(--ink)"
        }} />
        <div className="relative z-10 max-w-[1280px] mx-auto px-5 py-6 flex flex-wrap gap-4 items-start justify-between">
          <div className="flex flex-col gap-3">
            <h1 className="font-[Luckiest_Guy,cursive] text-[clamp(26px,4.4vw,46px)] m-0 leading-none tracking-wide text-[var(--sun)]"
              style={{ WebkitTextStroke: "2px var(--ink)", textShadow: "4px 4px 0 var(--ink)", transform: "rotate(-2deg)" }}>
              BEERIO KART
            </h1>
            <div className="font-[Fredoka] font-semibold text-[13px] tracking-wider text-[var(--ink)] bg-[var(--foam)] border-2 border-[var(--ink)] rounded-full px-3 py-1.5 inline-flex items-center gap-2 self-start shadow-[0_3px_0_rgba(22,35,59,.2)]">
              <span className="w-2 h-2 rounded-full bg-[var(--grass)] shadow-[0_0_0_2px_var(--ink)]" />
              🏎️ Double Elimination Night
            </div>
          </div>

          {/* Beer progress mug */}
          <div className="flex items-center gap-5 bg-[var(--foam)] border-3 border-[var(--ink)] rounded-[14px] px-4 py-2.5 shadow-[0_4px_0_rgba(22,35,59,.22)]"
            style={{ border: "3px solid var(--ink)" }}>
            <div className="relative w-[54px] h-[72px] border-[3px] border-[var(--ink)] rounded-[7px_7px_11px_11px] bg-white/60 overflow-hidden flex-shrink-0">
              <div className="absolute left-0 right-0 bottom-0 bg-gradient-to-b from-[var(--sun)] to-[var(--sun-deep)] transition-all duration-500"
                style={{ height: pct + "%" }} />
              <div className="absolute left-0 right-0 h-[9px] bg-[var(--foam)] rounded-[50%_50%_0_0/100%_100%_0_0] transition-all duration-500"
                style={{ bottom: pct + "%" }} />
              <div className="absolute -right-[15px] top-[13px] w-[15px] h-[32px] border-[3px] border-[var(--ink)] border-l-0 rounded-[0_11px_11px_0]" />
            </div>
            <div className="font-[Fredoka]">
              <div className="text-2xl font-bold text-[var(--ink)] leading-none">{done} / {playable}</div>
              <div className="text-[11px] text-[var(--ink-soft)] tracking-widest font-semibold mt-1">🍄 Heats Run</div>
            </div>
          </div>
        </div>
      </header>

      {/* Controls */}
      <div className="max-w-[1280px] mx-auto px-5 py-5 flex flex-wrap gap-6 items-start">
        <div className="flex-1 min-w-[280px]">
          <div className="font-[Fredoka] tracking-wide font-bold text-[15px] text-[var(--ink)] mb-3 flex items-center gap-3.5 flex-wrap">
            <span>Racers</span>
            <span className="inline-flex items-center gap-2">
              <button
                onClick={() => handleSetCount(playerCount - 1)}
                disabled={playerCount <= MIN_PLAYERS}
                className="w-8 h-8 rounded-[9px] border-[2.5px] border-[var(--ink)] bg-[var(--sun)] text-[var(--ink)] font-[Fredoka] text-xl font-bold cursor-pointer grid place-items-center shadow-[0_3px_0_rgba(22,35,59,.28)] active:translate-y-px active:shadow-[0_1px_0_rgba(22,35,59,.28)] transition-all disabled:opacity-40 disabled:cursor-default hover:bg-[var(--sun-deep)]"
              >−</button>
              <span className="font-[Fredoka] font-bold text-[22px] text-[var(--ink)] min-w-[30px] text-center">{playerCount}</span>
              <button
                onClick={() => handleSetCount(playerCount + 1)}
                disabled={playerCount >= MAX_PLAYERS}
                className="w-8 h-8 rounded-[9px] border-[2.5px] border-[var(--ink)] bg-[var(--sun)] text-[var(--ink)] font-[Fredoka] text-xl font-bold cursor-pointer grid place-items-center shadow-[0_3px_0_rgba(22,35,59,.28)] active:translate-y-px active:shadow-[0_1px_0_rgba(22,35,59,.28)] transition-all disabled:opacity-40 disabled:cursor-default hover:bg-[var(--sun-deep)]"
              >+</button>
              <span className="font-[Nunito] font-semibold text-[11px] tracking-wide text-[var(--muted)]">{capText}</span>
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
            {names.map((name, i) => (
              <div key={i} className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-[Fredoka] font-bold text-[12px] text-[var(--ink)] bg-[var(--sun)] border-2 border-[var(--ink)] w-[22px] h-[22px] rounded-[6px] grid place-items-center z-10">
                  {i + 1}
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={e => handleNameChange(i, e.target.value)}
                  placeholder={`Racer ${i + 1}`}
                  maxLength={18}
                  autoComplete="off"
                  className="w-full pl-10 pr-3 py-3 bg-white border-[2.5px] border-[var(--ink)] rounded-[11px] text-[var(--ink)] font-[Nunito] text-sm font-bold outline-none transition-shadow shadow-[0_3px_0_rgba(22,35,59,.14)] focus:shadow-[0_0_0_3px_var(--sun),0_3px_0_rgba(22,35,59,.14)] placeholder:text-[#A9B2C2] placeholder:font-semibold"
                />
                {!name.trim() && (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 font-[Fredoka] font-bold text-[10px] tracking-wide text-white bg-[var(--coral)] border-2 border-[var(--ink)] rounded-[6px] px-1.5 py-px pointer-events-none">
                    BYE
                  </span>
                )}
              </div>
            ))}
          </div>

          <p className="text-[12.5px] text-[var(--muted)] font-semibold leading-relaxed">
            Seed 1 is your strongest racer; the bracket auto-balances so favorites only meet later. Fewer racers than a power of two? Empty slots become byes automatically. Not sure on seeds? Hit Shuffle to draw at random.
          </p>
        </div>

        <div className="flex flex-col gap-3 min-w-[180px]">
          {[
            { icon: "❓", label: "Shuffle seeds", onClick: handleShuffle, primary: true },
            { icon: "↺", label: "Reset results", onClick: handleReset, primary: false },
            { icon: "🧹", label: "Clear names", onClick: handleClearAll, primary: false },
          ].map(btn => (
            <button
              key={btn.label}
              onClick={btn.onClick}
              className={`font-[Fredoka] tracking-wide font-semibold text-sm cursor-pointer px-4 py-3 rounded-[12px] border-[2.5px] border-[var(--ink)] text-[var(--ink)] shadow-[0_4px_0_rgba(22,35,59,.26)] active:translate-y-[2px] active:shadow-[0_1px_0_rgba(22,35,59,.26)] transition-all text-left flex items-center gap-2 ${btn.primary ? "bg-[var(--sun)] hover:bg-[var(--sun-deep)]" : "bg-white hover:bg-[var(--card2)]"}`}
            >
              <span className="text-base">{btn.icon}</span> {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stage */}
      <div className="max-w-[1280px] mx-auto px-5 pb-16">
        {realCount < 2 ? (
          <div className="mt-10 border-[3px] border-dashed border-[var(--ink)] rounded-[18px] p-14 text-center bg-[#FBF6EA]">
            <span className="text-5xl block mb-4">🏁</span>
            <h3 className="font-[Luckiest_Guy,cursive] text-[var(--ink)] text-2xl tracking-wider m-0 mb-3">READY TO RACE?</h3>
            <p className="font-[Nunito] font-semibold text-[var(--muted)] text-sm m-0 leading-relaxed">
              Set the number of racers above and drop in at least two names.<br />
              The bracket builds itself from there.
            </p>
          </div>
        ) : (
          <>
            {/* Winners Bracket */}
            <section className="mt-8">
              <div className="flex items-center gap-3 mb-4">
                <span className="w-3.5 h-3.5 border-[2.5px] border-[var(--ink)] rotate-45 rounded-sm bg-[var(--grass)]" />
                <span className="font-[Luckiest_Guy,cursive] text-xl tracking-wider text-white bg-[var(--grass)] border-[2.5px] border-[var(--ink)] rounded-[11px] px-3.5 py-1 shadow-[0_4px_0_rgba(22,35,59,.24)]"
                  style={{ transform: "rotate(-1deg)" }}>
                  Winners Bracket
                </span>
                <span className="h-[3px] bg-[var(--ink)] opacity-20 flex-1 rounded" />
              </div>
              <div className="flex gap-4 overflow-x-auto pb-3"
                style={{ scrollbarWidth: "thin", scrollbarColor: "#C9BFA8 transparent" }}>
                {wbGroups.map(g => (
                  <RoundColumn key={g.key} group={g} M={M} onSlotClick={handleSlotClick} />
                ))}
              </div>
            </section>

            {/* Losers Bracket */}
            {lbGroups.length > 0 && (
              <section className="mt-8">
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-3.5 h-3.5 border-[2.5px] border-[var(--ink)] rotate-45 rounded-sm bg-[var(--coral)]" />
                  <span className="font-[Luckiest_Guy,cursive] text-xl tracking-wider text-white bg-[var(--coral)] border-[2.5px] border-[var(--ink)] rounded-[11px] px-3.5 py-1 shadow-[0_4px_0_rgba(22,35,59,.24)]"
                    style={{ transform: "rotate(-1deg)" }}>
                    Losers Bracket
                  </span>
                  <span className="h-[3px] bg-[var(--ink)] opacity-20 flex-1 rounded" />
                </div>
                <div className="flex gap-4 overflow-x-auto pb-3"
                  style={{ scrollbarWidth: "thin", scrollbarColor: "#C9BFA8 transparent" }}>
                  {lbGroups.map(g => (
                    <RoundColumn key={g.key} group={g} M={M} onSlotClick={handleSlotClick} />
                  ))}
                </div>
              </section>
            )}

            {/* Grand Final */}
            <section className="mt-8">
              <div className="flex items-center gap-3 mb-4">
                <span className="w-3.5 h-3.5 border-[2.5px] border-[var(--ink)] rotate-45 rounded-sm bg-[var(--grape)]" />
                <span className="font-[Luckiest_Guy,cursive] text-xl tracking-wider text-white bg-[var(--grape)] border-[2.5px] border-[var(--ink)] rounded-[11px] px-3.5 py-1 shadow-[0_4px_0_rgba(22,35,59,.24)]"
                  style={{ transform: "rotate(-1deg)" }}>
                  Grand Final
                </span>
                <span className="h-[3px] bg-[var(--ink)] opacity-20 flex-1 rounded" />
              </div>
              <div className="flex flex-wrap gap-4 items-stretch">
                <div>
                  {gfMatches.map(id => (
                    <div key={id} className="mb-3">
                      <MatchCard
                        m={M[id]}
                        onSlotClick={handleSlotClick}
                        gfLabel={id === "GF" ? "Game 1" : "Reset · Game 2"}
                      />
                    </div>
                  ))}
                  {showReset && (
                    <p className="font-[Nunito] text-[11.5px] font-bold text-[var(--grape-deep)] mt-2 leading-relaxed">
                      Lower-bracket racer forced a reset. Both have one loss now, so one more game decides it.
                    </p>
                  )}
                </div>

                {/* Champion box */}
                <div className={`flex-1 min-w-[240px] rounded-2xl border-[3px] border-[var(--ink)] flex flex-col items-center justify-center gap-2 p-6 text-center shadow-[0_5px_0_rgba(22,35,59,.2)] ${champ ? "" : "border-dashed bg-[#FBF6EA]"}`}
                  style={champ ? {
                    background: "radial-gradient(130% 120% at 50% -10%, rgba(255,192,46,.55), rgba(255,192,46,0) 62%), var(--card2)"
                  } : {}}>
                  <span className="text-4xl drop-shadow-sm">{champ ? "🍻" : "🏁"}</span>
                  <span className="font-[Fredoka] tracking-[2px] text-xs text-[var(--sun-deep)] font-bold uppercase">Champion</span>
                  {champ ? (
                    <span className="font-[Luckiest_Guy,cursive] text-2xl text-[var(--ink)] leading-tight tracking-wide">{champ.name}</span>
                  ) : (
                    <span className="font-[Fredoka] font-semibold text-[var(--muted)] text-[15px]">To be crowned</span>
                  )}
                </div>
              </div>
            </section>

            {/* Legend */}
            <div className="flex flex-wrap gap-4 mt-8 pt-4 border-t-[3px] border-dotted border-[#C9BFA8] font-[Nunito] text-[12.5px] font-bold text-[var(--ink-soft)]">
              {[
                { color: "var(--grass)", label: "🍄 Winners bracket" },
                { color: "var(--coral)", label: "🐢 Losers bracket (one life left)" },
                { color: "var(--grape)", label: "⭐ Grand final" },
              ].map(l => (
                <span key={l.label} className="flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-[5px] border-2 border-[var(--ink)]" style={{ background: l.color + "66" }} />
                  {l.label}
                </span>
              ))}
              <span>👉 Tap a racer to mark them the heat winner. Tap again to undo.</span>
            </div>

            <p className="mt-4 font-[Nunito] text-[12.5px] font-semibold text-[var(--muted)] leading-relaxed">
              🍌 House rule reminder: finish your drink before crossing the line, no power-sliding past last call. First loss drops you to the losers bracket; a second loss and you're toast. The winners-bracket champ starts the grand final one game up, like grabbing a Star on the final lap.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
