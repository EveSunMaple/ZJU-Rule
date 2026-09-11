#!/usr/bin/env node
/**
 * 修复配置文件中失效的规则仓库地址。
 *
 * 背景：原上游 `ZJU-Rule/ZJU-Rule` 仓库已被删除（GitHub 404），
 * `zjurule.xyz` 也已下线，因此所有 config/*.ini、GeneralClashConfig.yml
 * 里写死的 raw.githubusercontent.com 链接全部 404，导致生成的订阅
 * 无法加载任何分流规则。
 *
 * 本脚本把这些失效地址改写成当前仍然可用的规则源。
 *
 * 用法：
 *   node tools/fix-rule-urls.mjs                  # 改写成默认源（见下）
 *   node tools/fix-rule-urls.mjs --base <URL>     # 改写成自定义规则源前缀
 *   node tools/fix-rule-urls.mjs --check          # 只检查，不写入
 *
 * 默认规则源前缀：
 *   https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEAD_BASE_URLS,
  DEFAULT_LIVE_BASE,
  countDeadUrls,
  rewriteBases,
} from '../lib/rule-urls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const baseIdx = args.indexOf('--base');
const liveBase = baseIdx >= 0 ? args[baseIdx + 1] : DEFAULT_LIVE_BASE;

if (!liveBase || !/^https?:\/\//.test(liveBase)) {
  console.error(`✗ 无效的规则源前缀: ${liveBase}`);
  process.exit(1);
}
if (!liveBase.endsWith('/')) {
  console.error(`✗ 规则源前缀必须以 / 结尾: ${liveBase}`);
  process.exit(1);
}

/** 收集需要处理的候选文件。 */
async function collectFiles() {
  const files = [];

  const push = async (dir, filter) => {
    let entries;
    try {
      entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && filter(entry.name)) files.push(path.posix.join(dir, entry.name));
    }
  };

  await push('Clash/config', (n) => n.endsWith('.ini'));
  await push('Clash', (n) => /\.(ini|ya?ml)$/.test(n));
  await push('Clash/Providers', (n) => /\.(ini|ya?ml)$/.test(n));

  return files.sort();
}

const files = await collectFiles();

let changedFiles = 0;
let changedLines = 0;

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const original = await readFile(abs, 'utf8');

  if (checkOnly) {
    // --check 只关心「已经失效」的地址，正常的规则源地址不算问题
    const dead = countDeadUrls(original);
    if (dead === 0) continue;
    changedFiles += 1;
    changedLines += dead;
    console.log(`✗ ${rel}  (${dead} 处失效链接)`);
    continue;
  }

  const { text, replacements } = rewriteBases(original, liveBase);
  if (replacements === 0) continue;

  changedFiles += 1;
  changedLines += replacements;
  await writeFile(abs, text, 'utf8');
  console.log(`✓ ${rel}  (已修复 ${replacements} 处)`);
}

console.log('');
if (changedFiles === 0) {
  console.log('没有发现失效链接，所有规则源均已指向可用的地址。');
} else if (checkOnly) {
  console.log(
    `发现 ${changedFiles} 个文件、共 ${changedLines} 处失效链接。` +
      `\n运行 \`node tools/fix-rule-urls.mjs --base ${liveBase}\` 进行修复。`,
  );
  console.log(`\n已识别的失效地址前缀:\n  ${DEAD_BASE_URLS.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(`共修复 ${changedFiles} 个文件、${changedLines} 处链接 → ${liveBase}`);
}
