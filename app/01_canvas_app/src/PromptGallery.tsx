import { useEffect, useRef, useState } from "react";
import { listPromptLibrary, savePromptCard, type PromptLibraryItem } from "./bridge-client";
import { STARTER_PROMPTS } from "./prompt-starters";

export async function copyPromptText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* local browser fallback */ }
  const input = document.createElement("textarea"); input.value = text;
  input.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(input); input.select();
  const copied = document.execCommand("copy"); input.remove();
  if (!copied) throw new Error("复制失败，请在详情中手动选择提示词");
}

function Cover({ card, index }: { card: PromptLibraryItem; index: number }) {
  if (card.coverDataUrl) return <img src={card.coverDataUrl} alt={`${card.title}参考封面`} loading="lazy" />;
  return <svg className={`sg-illustration sg-tone-${index % 6}`} viewBox="0 0 420 320" role="img" aria-label={`${card.title}示意插画，非生成效果`}>
    <rect width="420" height="320" fill="var(--sky)" /><circle cx="335" cy="68" r="28" fill="var(--sun)" />
    <path d="M0 256 420 210 420 320 0 320Z" fill="var(--ground)" />
    <path d="M80 254V136L203 80V245Z" fill="var(--wall)"/><path d="m203 80 94 44v132l-94-11Z" fill="var(--side)"/>
    {[0,1,2,3,4].map((n) => <path key={n} d={`M${94 + n * 21} ${138 - n * 9.6}V${243 - n * 1.5}`} stroke="var(--line)" strokeWidth="5" />)}
    {[0,1,2,3].map((n) => <path key={n} d={`m217 ${112 + n * 34} 65 29v16l-65-24Z`} fill="var(--glass)" />)}
    <path d="m43 279 280-26M106 295l222-22" stroke="var(--line)" opacity=".35" />
    <circle cx="337" cy="226" r="27" fill="var(--tree)"/><path d="M337 240v32" stroke="var(--line)" strokeWidth="3"/>
    <circle cx="51" cy="244" r="18" fill="var(--tree)"/><path d="M51 255v23" stroke="var(--line)" strokeWidth="3"/>
  </svg>;
}

export function PromptGallery({ onCanvas, hasProject }: { onCanvas(): void; hasProject: boolean }) {
  const [cards, setCards] = useState<PromptLibraryItem[]>([]);
  const [search, setSearch] = useState(""); const [category, setCategory] = useState("全部");
  const [detail, setDetail] = useState<PromptLibraryItem | null>(null);
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void listPromptLibrary().then(setCards).catch((e: Error) => setNotice(e.message)); }, []);
  const all = [...cards, ...STARTER_PROMPTS];
  const categories = ["全部", ...new Set(all.map((card) => card.category || "我的提示词"))];
  const filtered = all.filter((card) => (category === "全部" || (card.category || "我的提示词") === category)
    && `${card.title} ${card.content} ${card.inputHint ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  const copy = async (card: PromptLibraryItem) => {
    try { await copyPromptText(card.content); setNotice(`已复制「${card.title}」· 进入画布后粘贴即可`); } catch (e) { setNotice((e as Error).message); }
  };
  const importPack = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    let saved = 0;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("内容包不能超过 20 MiB");
      const pack = JSON.parse(await file.text()) as { cards?: PromptLibraryItem[] };
      if (!Array.isArray(pack.cards) || !pack.cards.length || pack.cards.length > 100) throw new Error("内容包须包含 1—100 张 cards 条目");
      for (const card of pack.cards) {
        if (typeof card.title !== "string" || !card.title.trim() || card.title.length > 40 || typeof card.content !== "string" || !card.content.trim() || card.content.length > 20_000) throw new Error("卡片标题或提示词长度无效");
        if (card.coverDataUrl && (card.coverDataUrl.length > 2_800_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(card.coverDataUrl))) throw new Error("封面格式或大小无效");
      }
      for (const card of pack.cards) {
        const existing = cards.find((entry) => entry.id === card.id);
        await savePromptCard({ ...card, id: existing?.id }); saved++;
      }
      setNotice(`已收录 ${saved} 张提示词卡片`);
    } catch (e) { setNotice(`已收录 ${saved} 张；${(e as Error).message}`); }
    finally { setCards(await listPromptLibrary().catch(() => cards)); setBusy(false); if (input.current) input.current.value = ""; }
  };
  return <section className="sg-gallery" aria-label="提示词库">
    <div className="sg-gallery-heading"><div><p className="sg-eyebrow">你的建筑表达收藏</p><h1>从一种表达，开始。</h1><p>选择喜欢的方向，复制提示词，回到画布开始渲染。</p></div>
      <button className="sg-primary" onClick={onCanvas}>{hasProject ? "回到画布" : "进入画布"}<span aria-hidden="true"> ↗</span></button></div>
    <div className="sg-gallery-tools"><nav aria-label="提示词分类">{categories.map((name) => <button key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</button>)}</nav>
      <input aria-label="搜索提示词" placeholder="搜索风格或用途" value={search} onChange={(e) => setSearch(e.target.value)} />
      <button disabled={busy} onClick={() => input.current?.click()}>{busy ? "收录中…" : "导入内容包"}</button><input ref={input} hidden type="file" accept=".json" onChange={(e) => void importPack(e.target.files?.[0])} /></div>
    {notice && <p role="status" className="sg-message">{notice}</p>}
    {detail ? <section className="sg-detail" aria-label="提示词详情"><div className="sg-detail-visual"><Cover card={detail} index={all.indexOf(detail)} /><small>{detail.coverLabel || "参考封面"}</small></div>
      <div className="sg-detail-copy"><button className="sg-back" onClick={() => setDetail(null)}>← 返回图库</button><p className="sg-eyebrow">{detail.category || "我的提示词"}</p><h2>{detail.title}</h2><p>适用输入：{detail.inputHint || "图片底图"}</p><textarea aria-label="完整提示词" readOnly value={detail.content} /><button className="sg-primary" onClick={() => void copy(detail)}>复制完整提示词</button><small>版本 {detail.version ?? 1} · 封面不随渲染任务上传</small></div></section>
      : <div className="sg-gallery-grid">{filtered.map((card, index) => <article className="sg-card" key={card.id}>
        <button className="sg-cover" onClick={() => setDetail(card)} aria-label={`查看${card.title}`}><Cover card={card} index={index} /><span>{card.coverLabel || (card.coverDataUrl ? "参考效果" : "文字提示词")}</span></button>
        <div className="sg-card-title"><div><h2><button onClick={() => setDetail(card)}>{card.title}</button></h2><p>{card.inputHint || card.category || "我的提示词"}</p></div><button className="sg-copy" onClick={() => void copy(card)} aria-label={`复制${card.title}`}>复制提示词</button></div>
      </article>)}</div>}
    {!filtered.length && !detail && <div className="sg-empty"><h2>暂时没有匹配的表达</h2><p>换一个关键词，或查看全部提示词。</p><button onClick={() => { setSearch(""); setCategory("全部"); }}>清除筛选</button></div>}
    <footer className="sg-gallery-foot">基础模板使用示意插画；你的清晰参考图可通过内容包收录为专属卡片。</footer>
  </section>;
}
