import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const maxUpload = 25 * 1024 * 1024;
const fps = 12;
const maxFrames = fps * 8;
const compact = { version: 3, width: 256, height: 160, columns: 4, rows: 4, extension: 'png' };
const highQuality = { version: 4, width: 512, height: 320, columns: 2, rows: 3, extension: 'jpg' };
const ultra = { version: 5, width: 1024, height: 704, columns: 1, rows: 1, extension: 'jpg' };
const smooth = { version: 6, width: 320, height: 208, columns: 3, rows: 4, extension: 'jpg' };
const smoothDetail = { version: 7, width: 480, height: 320, columns: 2, rows: 3, extension: 'jpg' };
const quality = { version: 8, width: 768, height: 512, columns: 1, rows: 2, extension: 'jpg' };

function mediaFormat(bytes) {
    const signature = bytes.toString('ascii', 0, 6);
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'gif';
    if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'mov';
    if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'matroska';
}

async function makeSheets(bytes, format, preset) {
    const { version, width, height, columns, rows, extension } = preset;
    const frameRate = version === 8 ? 32 : version >= 6 ? 60 : fps;
    const frameLimit = version >= 5 ? frameRate * 4 : maxFrames;
    const folder = await mkdtemp(join(tmpdir(), 'syllinse-frames-'));
    try {
        const input = join(folder, 'upload.bin');
        await writeFile(input, bytes);
        const filters = [
            'fps=' + frameRate + ':round=up',
            'trim=end_frame=' + frameLimit,
            'scale=' + width + ':' + height + ':force_original_aspect_ratio=increase:flags=lanczos'
                + (version >= 7 ? ':out_color_matrix=bt601:out_range=full' : ''),
            'crop=' + width + ':' + height,
            'setsar=1', 'showinfo', 'tile=' + columns + 'x' + rows + ':color=black',
        ].join(',');
        const outputOptions = extension === 'jpg'
            ? ['-c:v', 'mjpeg', '-q:v', version >= 7 ? '1' : '2', '-pix_fmt', 'yuvj444p'] : [];
        const { stderr } = await run(process.env.FFMPEG || 'ffmpeg', [
            '-hide_banner', '-loglevel', 'info', '-nostdin', '-max_alloc', '67108864',
            '-threads', '1', '-protocol_whitelist', 'file', '-f', format, '-i', input,
            '-map', '0:v:0', '-an', '-sn', '-dn', '-filter_threads', '1', '-vf', filters,
            '-fps_mode', 'passthrough', '-threads:v', '1', ...outputOptions, join(folder, 'sheet-%03d.' + extension),
        ], { timeout: 22_000, maxBuffer: 512 * 1024, windowsHide: true });
        const matches = [...stderr.matchAll(/showinfo[^\r\n]*?\bn:\s*(\d+)/g)];
        const frameCount = Number(matches.at(-1)?.[1]) + 1;
        const files = (await readdir(folder)).filter(name => name.startsWith('sheet-') && name.endsWith('.' + extension)).sort();
        if (!frameCount || frameCount > frameLimit || files.length !== Math.ceil(frameCount / (columns * rows))) {
            throw new Error('Could not determine sprite frame count');
        }
        const sizes = await Promise.all(files.map(name => stat(join(folder, name))));
        const encodedSize = sizes.reduce((total, file) => total + Math.ceil(file.size / 3) * 4, 0);
        if (encodedSize > 30 * 1024 * 1024) return null;
        const pages = await Promise.all(files.map(async name => (await readFile(join(folder, name))).toString('base64')));
        return { Version: version, Fps: frameRate, FrameCount: frameCount, CellWidth: width, CellHeight: height,
            Columns: columns, Rows: rows, Pages: pages };
    } finally {
        for (const file of await readdir(folder)) await unlink(join(folder, file));
        await rmdir(folder);
    }
}

async function makeLoopSheets(bytes, format) {
    const folder = await mkdtemp(join(tmpdir(), 'syllinse-loop-'));
    try {
        const input = join(folder, 'upload.bin');
        await writeFile(input, bytes);
        const probe = await run(process.env.FFPROBE || 'ffprobe', [
            '-v', 'error', '-protocol_whitelist', 'file', '-f', format, '-i', input,
            '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate,duration:format=duration',
            '-of', 'json',
        ], { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
        const info = JSON.parse(probe.stdout);
        const stream = info.streams?.[0];
        const fraction = value => {
            const [a, b = 1] = String(value).split('/').map(Number);
            return Number.isFinite(a / b) && a / b > 0 ? a / b : 0;
        };
        const frameRate = Math.min(32, fraction(stream?.avg_frame_rate) || fraction(stream?.r_frame_rate) || 24);
        const sourceDuration = Number(stream?.duration) || Number(info.format?.duration);
        if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('Unknown clip duration');
        const totalFrames = Math.max(1, Math.floor(Math.min(sourceDuration, 8) * frameRate));
        const blendFrames = Math.min(Math.max(1, Math.round(frameRate * 0.2)), Math.floor(totalFrames / 4));
        const outputFrames = totalFrames - blendFrames;
        const profiles = [
            { width: 512, height: 336, columns: 2, rows: 3 },
            { width: 480, height: 320, columns: 2, rows: 3 },
            { width: 384, height: 240, columns: 2, rows: 4 },
            { width: 320, height: 208, columns: 3, rows: 4 },
        ];
        const profile = profiles.find(p => Math.ceil(outputFrames / (p.columns * p.rows))
            * p.width * p.height * p.columns * p.rows <= 24 * 1024 * 1024);
        if (!profile) throw new Error('Loop exceeds texture budget');
        const { width, height, columns, rows } = profile;
        const base = '[0:v]fps=' + frameRate + ':round=up,trim=end_frame=' + totalFrames
            + ',scale=' + width + ':' + height + ':force_original_aspect_ratio=increase:flags=lanczos'
            + ':out_color_matrix=bt601:out_range=full,crop=' + width + ':' + height
            + ',setsar=1,format=yuv444p,settb=AVTB,setpts=PTS-STARTPTS';
        let filter;
        if (blendFrames > 0) {
            filter = base + ',split=3[mid][tail][head];'
                + '[mid]trim=start_frame=' + blendFrames + ':end_frame=' + (totalFrames - blendFrames) + ',setpts=PTS-STARTPTS[m];'
                + '[tail]trim=start_frame=' + (totalFrames - blendFrames) + ':end_frame=' + totalFrames + ',setpts=PTS-STARTPTS[t];'
                + '[head]trim=end_frame=' + blendFrames + ',setpts=PTS-STARTPTS[h];'
                + '[t][h]xfade=transition=fade:duration=' + (blendFrames / frameRate) + ':offset=0[join];'
                + '[m][join]concat=n=2:v=1:a=0,fps=' + frameRate + ':round=near,trim=end_frame=' + outputFrames;
        } else {
            filter = base;
        }
        filter += ',showinfo,tile=' + columns + 'x' + rows + ':color=black[out]';
        const { stderr } = await run(process.env.FFMPEG || 'ffmpeg', [
            '-hide_banner', '-loglevel', 'info', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file',
            '-f', format, '-i', input, '-filter_complex_threads', '1', '-filter_complex', filter,
            '-map', '[out]', '-an', '-sn', '-dn', '-fps_mode', 'passthrough',
            '-c:v', 'mjpeg', '-q:v', '1', '-pix_fmt', 'yuvj444p', '-threads:v', '1', join(folder, 'sheet-%03d.jpg'),
        ], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
        const matches = [...stderr.matchAll(/showinfo[^\r\n]*?\bn:\s*(\d+)/g)];
        const frameCount = Number(matches.at(-1)?.[1]) + 1;
        const files = (await readdir(folder)).filter(name => /^sheet-\d+\.jpg$/.test(name)).sort();
        if (!frameCount || frameCount > totalFrames || files.length !== Math.ceil(frameCount / (columns * rows))) {
            throw new Error('Invalid converted loop');
        }
        const sizes = await Promise.all(files.map(name => stat(join(folder, name))));
        if (sizes.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0) > 30 * 1024 * 1024) {
            throw new Error('Loop images exceed transfer budget');
        }
        return {
            Version: 9, Fps: frameRate, FrameCount: frameCount, CellWidth: width, CellHeight: height,
            Columns: columns, Rows: rows,
            Pages: await Promise.all(files.map(async file => (await readFile(join(folder, file))).toString('base64'))),
            Duration: frameCount / frameRate, SourceDuration: sourceDuration, LoopBlendFrames: blendFrames,
        };
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
    const cache = new Map();
    let cacheBytes = 0;
    const server = createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, loopVersion: 9 });
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
            if (req.headers['x-syllinse-sprite-loop'] === '1') {
                const key = createHash('sha256').update(bytes).update('loop-v9').digest('hex');
                let body = cache.get(key);
                res.setHeader('X-Syllinse-Cache', body ? 'hit' : 'miss');
                if (!body) {
                    let result;
                    try {
                        result = await makeLoopSheets(bytes, format);
                    } catch {
                        // Keep unusual containers playable if their timing metadata cannot be read.
                        result = await makeSheets(bytes, format, highQuality);
                    }
                    if (!result) return json(res, 422, { error: 'Loop images are too large. Try a shorter clip.' });
                    body = JSON.stringify(result);
                    const size = Buffer.byteLength(body);
                    while (cacheBytes + size > 64 * 1024 * 1024 && cache.size) {
                        const oldest = cache.keys().next().value;
                        cacheBytes -= Buffer.byteLength(cache.get(oldest));
                        cache.delete(oldest);
                    }
                    cache.set(key, body);
                    cacheBytes += size;
                }
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(body);
                return;
            }
            const requestedVersion = req.headers['x-syllinse-sprite-version'];
            const mode = req.headers['x-syllinse-sprite-quality'];
            const detailRequested = req.headers['x-syllinse-sprite-detail'] === '1';
            const qualityRequested = req.headers['x-syllinse-sprite-profile'] === 'quality';
            let preset = mode === 'smooth' ? (detailRequested ? smoothDetail : smooth)
                : mode === 'ultra' ? ultra : requestedVersion === '4' ? highQuality : compact;
            if (qualityRequested) preset = quality;
            let result = await makeSheets(bytes, format, preset);
            if (!result && (preset === quality || preset === smoothDetail)) {
                if (preset === quality) result = await makeSheets(bytes, format, smoothDetail);
                if (!result) result = await makeSheets(bytes, format, smooth);
            }
            if (!result && preset.version >= 5) result = await makeSheets(bytes, format, highQuality);
            if (!result) return json(res, 422, { error: 'Sprite images are too large. Try a shorter clip.' });
            json(res, 200, result);
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

