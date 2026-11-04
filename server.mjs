import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const maxUpload = 25 * 1024 * 1024;
const fps = 12;
const maxFrames = fps * 8;
const width = 256;
const height = 160;
const columns = 4;
const rows = 4;

function mediaFormat(bytes) {
    const signature = bytes.toString('ascii', 0, 6);
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'gif';
    if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'mov';
    if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'matroska';
}

async function makeSheets(bytes, format) {
    const folder = await mkdtemp(join(tmpdir(), 'syllinse-frames-'));
    try {
        const input = join(folder, 'upload.bin');
        await writeFile(input, bytes);
        const filters = [
            'fps=' + fps + ':round=up',
            'trim=end_frame=' + maxFrames,
            'scale=' + width + ':' + height + ':force_original_aspect_ratio=increase',
            'crop=' + width + ':' + height,
            'setsar=1', 'showinfo', 'tile=' + columns + 'x' + rows + ':color=black',
        ].join(',');
        const { stderr } = await run(process.env.FFMPEG || 'ffmpeg', [
            '-hide_banner', '-loglevel', 'info', '-nostdin', '-max_alloc', '67108864',
            '-threads', '1', '-protocol_whitelist', 'file', '-f', format, '-i', input,
            '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '1', '-vf', filters,
            '-fps_mode', 'passthrough', '-threads:v', '1', join(folder, 'sheet-%03d.png'),
        ], { timeout: 22_000, maxBuffer: 512 * 1024, windowsHide: true });
        const matches = [...stderr.matchAll(/showinfo[^\r\n]*?\bn:\s*(\d+)/g)];
        const frameCount = Number(matches.at(-1)?.[1]) + 1;
        const files = (await readdir(folder)).filter(name => /^sheet-\d+\.png$/.test(name)).sort();
        if (!frameCount || frameCount > maxFrames || files.length !== Math.ceil(frameCount / (columns * rows))) {
            throw new Error('Could not determine sprite frame count');
        }
        const pages = await Promise.all(files.map(async name => (await readFile(join(folder, name))).toString('base64')));
        return { Version: 3, Fps: fps, FrameCount: frameCount, CellWidth: width, CellHeight: height,
            Columns: columns, Rows: rows, Pages: pages };
    } finally {
        for (const file of await readdir(folder)) await unlink(join(folder, file));
        await rmdir(folder);
    }
}

function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}

export function createConverter() {
    let busy = false;
    const server = createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
        if (req.method !== 'POST' || req.url !== '/frames') return json(res, 404, { error: 'Use POST /frames' });
        if (req.headers['content-type'] !== 'application/octet-stream') {
            return json(res, 415, { error: 'Send the video bytes as application/octet-stream' });
        }
        const expected = Number(req.headers['content-length']);
        if (!Number.isInteger(expected) || expected < 17 || expected > maxUpload) {
            return json(res, 413, { error: 'Use a file between 17 bytes and 25 MB' });
        }
        if (busy) {
            res.setHeader('Retry-After', '3');
            return json(res, 503, { error: 'Converter busy. Try again shortly.' });
        }

        busy = true;
        const timer = setTimeout(() => req.destroy(), 20_000);
        try {
            const parts = [];
            let received = 0;
            for await (const chunk of req) {
                received += chunk.length;
                if (received > expected) return json(res, 413, { error: 'Upload too large' });
                parts.push(chunk);
            }
            clearTimeout(timer);
            if (received !== expected) return json(res, 400, { error: 'Incomplete upload' });
            const bytes = Buffer.concat(parts, received);
            const format = mediaFormat(bytes);
            if (!format) return json(res, 415, { error: 'Send an MP4, WebM or GIF file' });
            json(res, 200, await makeSheets(bytes, format));
        } catch {
            if (!res.destroyed && !res.headersSent) json(res, 422, { error: 'Could not convert this clip. Try a shorter or smaller file.' });
        } finally {
            clearTimeout(timer);
            busy = false;
        }
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 25_000;
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.PORT || 3000);
    createConverter().listen(port, '0.0.0.0', () => console.log('Sprite converter listening on port ' + port));
}

