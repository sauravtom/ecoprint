#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright-core');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const CHROME_PATH_CANDIDATES = [
  process.env.ECOPRINT_CHROME_PATH,
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const A4_PORTRAIT = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };

function usage() {
  console.log('Usage: node ecoprint.js <url1> [url2 ...] [--outdir ./out] [--keep-source] [--keep-media]');
}

function sanitizeName(input) {
  try {
    const u = new URL(input);
    const slug = `${u.hostname}${u.pathname}${u.search}`
      .replace(/^www\./, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100);
    return slug || 'document';
  } catch {
    return input.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'document';
  }
}

function parseArgs(argv) {
  const urls = [];
  let outdir = process.cwd();
  let keepSource = false;
  let keepMedia = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--outdir') {
      outdir = argv[i + 1] ? path.resolve(argv[i + 1]) : outdir;
      i += 1;
      continue;
    }
    if (arg === '--keep-source') {
      keepSource = true;
      continue;
    }
    if (arg === '--keep-media') {
      keepMedia = true;
      continue;
    }
    urls.push(arg);
  }

  return { urls, outdir, keepSource, keepMedia };
}

async function preparePage(page, options = {}) {
  const { keepMedia = false } = options;
  // Force lazy assets to load first (many long-form sites defer chart/images until scrolled).
  await page.evaluate(async () => {
    const setIfEmpty = (el, attr, value) => {
      if (!el.getAttribute(attr) && value) el.setAttribute(attr, value);
    };

    for (const img of Array.from(document.querySelectorAll('img'))) {
      const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      const dataSrcSet = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
      if ((!img.getAttribute('src') || img.getAttribute('src') === 'data:,') && dataSrc) {
        img.setAttribute('src', dataSrc);
      }
      if (!img.getAttribute('srcset') && dataSrcSet) {
        img.setAttribute('srcset', dataSrcSet);
      }
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
      img.setAttribute('fetchpriority', 'high');
    }

    for (const source of Array.from(document.querySelectorAll('source'))) {
      const dataSrcSet = source.getAttribute('data-srcset');
      if (!source.getAttribute('srcset') && dataSrcSet) {
        source.setAttribute('srcset', dataSrcSet);
      }
    }

    const maxY = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight
    );
    const step = Math.max(700, Math.floor(window.innerHeight * 0.9));
    for (let y = 0; y < maxY; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(1200);

  // Expand collapsible UI first so print captures full content, not teaser cards.
  await page.evaluate(() => {
    const clickables = Array.from(
      document.querySelectorAll('button, [role="button"], summary, [aria-expanded], [aria-controls]')
    );

    for (const el of clickables) {
      const node = /** @type {HTMLElement} */ (el);
      const txt = (node.textContent || '').trim();
      const aria = node.getAttribute('aria-label') || '';
      const expanded = node.getAttribute('aria-expanded');
      const shouldOpen =
        expanded === 'false' ||
        txt === '+' ||
        txt.toLowerCase() === 'more' ||
        txt.toLowerCase().includes('read more') ||
        aria.toLowerCase().includes('expand') ||
        aria.toLowerCase().includes('show more');

      if (shouldOpen) {
        node.click();
      }
    }

    for (const d of Array.from(document.querySelectorAll('details'))) {
      d.open = true;
    }
  });

  await page.waitForTimeout(600);

  await page.emulateMedia({ media: 'print' });
  await page.addStyleTag({
    content: `
      @page { size: A4; margin: 14mm 12mm; }
      html, body { print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; }
      * { animation: none !important; transition: none !important; }
      img, svg, video, canvas, table, pre, blockquote { break-inside: avoid; page-break-inside: avoid; max-width: 100% !important; }
      h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
      p, li { orphans: 3; widows: 3; }
      main, article, section, div {
        max-height: none !important;
      }
      ${
        keepMedia
          ? ''
          : `
      /* Paper-save mode: remove oversized lightbox media cards that create large blank blocks. */
      .content-lightbox-wrapper,
      .content-lightbox-zoom,
      a.lightbox-enabled,
      [class*="lightbox-overlay" i],
      [class*="zoom-overlay" i] {
        display: none !important;
        visibility: hidden !important;
      }
      `
      }
    `,
  });

  await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('*'));
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      const pos = style.position;
      if (pos === 'fixed' || pos === 'sticky') {
        const text = (node.textContent || '').toLowerCase();
        const suspicious = ['cookie', 'subscribe', 'newsletter', 'accept', 'consent', 'sign in', 'log in'];
        if (suspicious.some((token) => text.includes(token)) || Number(style.zIndex) >= 40) {
          node.style.display = 'none';
        }
      }
    }

    // Collapse giant, low-content containers that waste paper in print.
    for (const node of nodes) {
      const el = /** @type {HTMLElement} */ (node);
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      const textLen = (el.innerText || '').replace(/\s+/g, ' ').trim().length;
      const hasMedia = el.querySelector('img, video, canvas, svg, iframe');
      const h = el.getBoundingClientRect().height;
      const minH = parseFloat(style.minHeight || '0') || 0;

      const likelyBloated =
        (h > 500 || minH > 500) &&
        textLen < 1200 &&
        !hasMedia &&
        (style.display === 'block' || style.display === 'flex' || style.display === 'grid');

      if (likelyBloated) {
        el.style.minHeight = '0';
        el.style.height = 'auto';
        el.style.maxHeight = 'none';
      }
    }
  });
}

async function makeTwoUp(inputPdfPath, outputPdfPath, sourceLabel) {
  const srcBytes = await fs.readFile(inputPdfPath);
  const src = await PDFDocument.load(srcBytes);
  const out = await PDFDocument.create();

  const outerMargin = 18;
  const gutter = 14;
  const cellW = (A4_LANDSCAPE.width - (2 * outerMargin) - gutter) / 2;
  const cellH = A4_LANDSCAPE.height - (2 * outerMargin);

  const font = await out.embedFont(StandardFonts.Helvetica);

  const pages = src.getPages();
  for (let i = 0; i < pages.length; i += 2) {
    const sheet = out.addPage([A4_LANDSCAPE.width, A4_LANDSCAPE.height]);
    for (let slot = 0; slot < 2; slot += 1) {
      const srcIndex = i + slot;
      if (srcIndex >= pages.length) continue;

      const srcPage = pages[srcIndex];
      const embedded = await out.embedPage(srcPage);
      const srcW = srcPage.getWidth();
      const srcH = srcPage.getHeight();
      const scale = Math.min(cellW / srcW, cellH / srcH);
      const drawW = srcW * scale;
      const drawH = srcH * scale;
      const x0 = outerMargin + slot * (cellW + gutter);
      const y0 = outerMargin;
      const x = x0 + (cellW - drawW) / 2;
      const y = y0 + (cellH - drawH) / 2;

      sheet.drawRectangle({
        x: x0,
        y: y0,
        width: cellW,
        height: cellH,
        borderWidth: 0.6,
        borderColor: rgb(0.85, 0.85, 0.85),
      });

      sheet.drawPage(embedded, { x, y, width: drawW, height: drawH });

      const label = `p.${srcIndex + 1}`;
      sheet.drawText(label, {
        x: x0 + cellW - 24,
        y: y0 + 4,
        size: 8,
        font,
        color: rgb(0.45, 0.45, 0.45),
      });
    }

    const footer = sourceLabel.slice(0, 100);
    sheet.drawText(footer, {
      x: outerMargin,
      y: 6,
      size: 7,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  const bytes = await out.save();
  await fs.writeFile(outputPdfPath, bytes);
}

async function run() {
  const { urls, outdir, keepSource, keepMedia } = parseArgs(process.argv);

  if (!urls.length) {
    usage();
    process.exit(1);
  }

  await fs.mkdir(outdir, { recursive: true });

  let browser;
  let lastError;
  for (const executablePath of CHROME_PATH_CANDIDATES) {
    try {
      browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--disable-dev-shm-usage', '--no-sandbox'],
      });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!browser) {
    const tried = CHROME_PATH_CANDIDATES.join(', ');
    throw new Error(
      `Could not launch a Chromium browser. Tried: ${tried}. Set ECOPRINT_CHROME_PATH to your browser binary path. Last error: ${lastError?.message || 'unknown'}`
    );
  }

  try {
    for (const url of urls) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 2200 } });
      const basename = sanitizeName(url);
      const sourcePdf = path.join(outdir, `${basename}.print.pdf`);
      const finalPdf = path.join(outdir, `${basename}.2up.pdf`);

      console.log(`Rendering: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
      await page.waitForTimeout(2500);
      await preparePage(page, { keepMedia });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(700);

      await page.pdf({
        path: sourcePdf,
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: false,
        preferCSSPageSize: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });

      await makeTwoUp(sourcePdf, finalPdf, url);
      if (!keepSource) {
        await fs.unlink(sourcePdf).catch(() => {});
      }

      await page.close();
      console.log(`Saved: ${finalPdf}`);
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
