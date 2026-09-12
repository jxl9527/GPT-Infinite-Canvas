import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, basename, join } from 'node:path';

// Read only the explicitly supplied manifest and cover files; never modify originals.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('用法：node scripts/create-prompt-pack.mjs 清单.json 输出目录');
const manifestPath = resolve(input);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest.cards) || !manifest.cards.length || manifest.cards.length > 100) throw new Error('cards 须包含 1—100 条内容');
const cards = [];
for (const card of manifest.cards) {
  if (typeof card.title !== 'string' || !card.title.trim() || card.title.length > 40 || typeof card.content !== 'string' || !card.content.trim() || card.content.length > 20000) throw new Error('标题或提示词长度无效');
  const { coverPath, ...entry } = card;
  if (coverPath) {
    const path = resolve(dirname(manifestPath), coverPath);
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()];
    const bytes = await readFile(path);
    if (!mime || bytes.length > 2 * 1024 * 1024) throw new Error(`${basename(path)}：封面须为 2 MiB 内 PNG/JPEG/WebP`);
    entry.coverDataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  }
  cards.push(entry);
}
const directory = resolve(output); await mkdir(directory, { recursive: true });
const content = JSON.stringify({ schemaVersion: '1.0', cards }, null, 2);
if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new Error('内容包超过 20 MiB，请拆分');
let path;
for (let version = 1; ; version++) {
  path = join(directory, `提示词内容包${version === 1 ? '' : `_v${version}`}.json`);
  try { await writeFile(path, content, { flag: 'wx' }); break; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
await appendFile(join(directory, 'prompt-pack.ndjson'), JSON.stringify({ at: new Date().toISOString(), source: manifestPath, output: path, cards: cards.length }) + '\n');
console.log(JSON.stringify({ path, cards: cards.length }));
