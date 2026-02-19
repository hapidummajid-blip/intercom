#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                INTERCOM-ALERT  v1.0.0                       ║
 * ║      Decentralized P2P Alert & Notification System          ║
 * ║      Built for the Intercom Vibe Competition                ║
 * ║      Trac Network | Hyperswarm | Termux-Ready               ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * FEATURES:
 *   · Three severity levels: INFO · WARN · CRITICAL
 *   · Per-peer subscribe filter (only receive what you care about)
 *   · Auto-repeat CRITICAL alerts every N seconds until ACK'd
 *   · Termux push notifications via termux-notification API
 *   · Append-only local alert log (alert-log.txt)
 *   · Broadcast to all peers in the channel
 *
 * Author : [INSERT_YOUR_TRAC_ADDRESS_HERE]
 * License: MIT
 */

import Hyperswarm from 'hyperswarm'
import b4a        from 'b4a'
import crypto     from 'crypto'
import readline   from 'readline'
import fs         from 'fs'
import { execSync, exec } from 'child_process'

// ─── Config ────────────────────────────────────────────────────────────────

const APP_VERSION     = '1.0.0'
const DEFAULT_CHANNEL = 'intercom-alert-v1-global'
const LOG_FILE        = 'alert-log.txt'

// How often (ms) unacknowledged CRITICAL alerts are re-broadcast
const REPEAT_INTERVAL_MS = 15_000   // 15 seconds

// Severity levels in priority order
const LEVELS = ['INFO', 'WARN', 'CRITICAL']

// ─── ANSI colours ──────────────────────────────────────────────────────────

const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  cyan   : '\x1b[36m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  red    : '\x1b[31m',
  magenta: '\x1b[35m',
  blue   : '\x1b[34m',
  white  : '\x1b[97m',
  bgRed  : '\x1b[41m',
  bgYel  : '\x1b[43m',
}

// Per-level display config
const LEVEL_CFG = {
  INFO    : { icon: 'ℹ️ ', color: 'blue',    badge: `${C.blue}[INFO]${C.reset}`                         },
  WARN    : { icon: '⚠️ ', color: 'yellow',  badge: `${C.yellow}${C.bold}[WARN]${C.reset}`              },
  CRITICAL: { icon: '🚨 ', color: 'red',     badge: `${C.bgRed}${C.white}${C.bold}[CRITICAL]${C.reset}` },
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function topicFromString (str) {
  return crypto.createHash('sha256').update(str).digest()
}

function shortId (hex) {
  return hex.slice(0, 8) + '…' + hex.slice(-4)
}

function ts () { return new Date().toLocaleTimeString() }
function iso () { return new Date().toISOString() }

function log (icon, colorKey, msg) {
  process.stdout.write(`\r${C[colorKey] ?? ''}[${ts()}] ${icon}${C.reset} ${msg}\n> `)
}

function encode (obj) { return Buffer.from(JSON.stringify(obj) + '\n') }
function decode (str) {
  try { return JSON.parse(str.trim()) } catch { return null }
}

// ─── Termux notification ────────────────────────────────────────────────────

// Detect if termux-notification is available (Android Termux)
const HAS_TERMUX = (() => {
  try { execSync('which termux-notification', { stdio: 'ignore' }); return true }
  catch { return false }
})()

function termuxNotify (level, sender, message, alertId) {
  if (!HAS_TERMUX) return
  const title   = `intercom-alert ${LEVEL_CFG[level]?.icon ?? ''} ${level}`
  const content = `[${sender}] ${message}`
  const id      = Math.abs(Buffer.from(alertId, 'hex').readUInt16BE(0)) // stable int id
  const sound   = level === 'CRITICAL' ? '--vibrate 1000 --led-color red' : ''
  const cmd     = `termux-notification --title "${title}" --content "${content}" --id ${id} ${sound} &`
  exec(cmd, () => {}) // fire and forget
}

// ─── State ──────────────────────────────────────────────────────────────────

let myAlias   = ''
let myPeerId  = ''

const peers   = new Map()   // peerId hex → { conn, alias, subscribedLevels }

// Subscribe filter: which levels THIS peer wants to receive
// Default: receive everything
let mySubscribe = new Set(['INFO', 'WARN', 'CRITICAL'])

// Active CRITICAL alerts awaiting ACK  alertId → { timer, data }
const pendingAcks = new Map()

// In-memory alert history (last 50)
const alertHistory = []

// ─── Wire protocol ──────────────────────────────────────────────────────────

const MSG = {
  INFO      : 'INFO',       // peer announce + subscribe levels
  ALERT     : 'ALERT',      // send an alert
  ACK       : 'ACK',        // acknowledge a CRITICAL alert
  SUBSCRIBE : 'SUBSCRIBE',  // update subscription filter
}

// ─── Networking ─────────────────────────────────────────────────────────────

let swarm

function broadcast (obj) {
  const frame = encode(obj)
  for (const [, peer] of peers) {
    try { peer.conn.write(frame) } catch { /* ignore */ }
  }
}

function handleConnection (conn, info) {
  const pid   = b4a.toString(info.publicKey, 'hex')
  const short = shortId(pid)

  peers.set(pid, { conn, alias: short, subscribedLevels: new Set(LEVELS) })
  log('⟳', 'green', `Peer terhubung: ${short}  (total: ${peers.size})`)

  // Announce ourselves + our subscribe filter
  try {
    conn.write(encode({
      type     : MSG.INFO,
      alias    : myAlias,
      version  : APP_VERSION,
      subscribe: [...mySubscribe],
    }))
  } catch { /* ignore */ }

  let buf = ''
  conn.on('data', data => {
    buf += data.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = decode(line)
      if (msg) handleMessage(pid, short, msg)
    }
  })

  conn.on('close', () => {
    peers.delete(pid)
    log('✕', 'dim', `${short} terputus  (sisa: ${peers.size})`)
  })

  conn.on('error', err => {
    if (err.code !== 'ECONNRESET') log('✕', 'red', `${short}: ${err.message}`)
    peers.delete(pid)
  })
}

// ─── Message handler ────────────────────────────────────────────────────────

function handleMessage (pid, short, msg) {
  const peer = peers.get(pid)

  switch (msg.type) {

    // ── Peer announce ─────────────────────────────────────────────────────
    case MSG.INFO: {
      if (peer) {
        peer.alias = msg.alias || short
        if (Array.isArray(msg.subscribe)) {
          peer.subscribedLevels = new Set(msg.subscribe.filter(l => LEVELS.includes(l)))
        }
      }
      const sub = msg.subscribe ? msg.subscribe.join(', ') : 'ALL'
      log('ℹ', 'blue', `${msg.alias || short} online — subscribe: ${sub}`)
      break
    }

    // ── Incoming alert ────────────────────────────────────────────────────
    case MSG.ALERT: {
      const { alertId, level, message, sender, repeat } = msg

      // Respect local subscribe filter
      if (!mySubscribe.has(level)) break

      const cfg    = LEVEL_CFG[level] ?? LEVEL_CFG.INFO
      const from   = (peer && peer.alias) || sender || short
      const prefix = cfg.badge

      // Display the alert prominently
      if (level === 'CRITICAL') {
        process.stdout.write(`\r\n`)
        process.stdout.write(`${C.bgRed}${C.white}${C.bold}` +
          `╔══════════════════════════════════════════════════╗\n` +
          `║  🚨  CRITICAL ALERT                              ║\n` +
          `╚══════════════════════════════════════════════════╝` +
          `${C.reset}\n`)
      }

      const repeatTag = repeat ? ` ${C.dim}(ulang ke-${repeat})${C.reset}` : ''
      log(cfg.icon, cfg.color, `${prefix} dari ${C.cyan}${from}${C.reset}${repeatTag}: ${C.white}${message}${C.reset}`)

      // Termux notification
      termuxNotify(level, from, message, alertId || '0000')

      // Record in history
      const entry = { alertId, level, message, from, ts: iso(), acked: false }
      alertHistory.unshift(entry)
      if (alertHistory.length > 50) alertHistory.pop()
      appendLog(`[${level}] from=${from} msg="${message}" id=${alertId}`)

      // If CRITICAL, show ACK hint
      if (level === 'CRITICAL') {
        process.stdout.write(`  ${C.yellow}→ Ketik /ack ${alertId} untuk acknowledge${C.reset}\n> `)
      }
      break
    }

    // ── ACK received ──────────────────────────────────────────────────────
    case MSG.ACK: {
      const { alertId } = msg
      const from = (peer && peer.alias) || short

      // Stop repeating if we were the ones who sent this alert
      if (pendingAcks.has(alertId)) {
        clearInterval(pendingAcks.get(alertId).timer)
        pendingAcks.delete(alertId)
        log('✅', 'green', `CRITICAL alert ${C.dim}${alertId}${C.reset} di-ACK oleh ${C.cyan}${from}${C.reset} — berhenti repeat.`)
      }

      // Mark in history
      for (const e of alertHistory) {
        if (e.alertId === alertId) { e.acked = true; e.ackedBy = from; break }
      }
      break
    }

    // ── Subscribe update ──────────────────────────────────────────────────
    case MSG.SUBSCRIBE: {
      if (peer && Array.isArray(msg.levels)) {
        peer.subscribedLevels = new Set(msg.levels.filter(l => LEVELS.includes(l)))
        log('🔔', 'magenta', `${peer.alias} update subscribe → ${msg.levels.join(', ')}`)
      }
      break
    }
  }
}

// ─── Send alert ─────────────────────────────────────────────────────────────

function sendAlert (level, message) {
  if (!LEVELS.includes(level)) {
    log('✕', 'red', `Level tidak valid: ${level}. Pilih: INFO, WARN, CRITICAL`)
    return
  }
  if (!message || !message.trim()) {
    log('✕', 'red', 'Pesan tidak boleh kosong.')
    return
  }

  const alertId = crypto.randomBytes(4).toString('hex')
  const cfg     = LEVEL_CFG[level]

  const frame = {
    type   : MSG.ALERT,
    alertId,
    level,
    message: message.trim(),
    sender : myAlias,
  }

  // Count recipients who subscribe to this level
  let sent = 0
  for (const [, peer] of peers) {
    if (peer.subscribedLevels.has(level)) {
      try { peer.conn.write(encode(frame)); sent++ } catch { /* ignore */ }
    }
  }

  const cfg2 = LEVEL_CFG[level]
  log(cfg2.icon, cfg2.color,
    `${cfg.badge} dikirim ke ${sent} peer — "${message.trim().slice(0, 60)}" ${C.dim}[${alertId}]${C.reset}`)

  // Log locally too
  appendLog(`[SENT][${level}] msg="${message.trim()}" id=${alertId} recipients=${sent}`)

  // Record in history
  alertHistory.unshift({ alertId, level, message: message.trim(), from: myAlias, ts: iso(), acked: false, sent: true })
  if (alertHistory.length > 50) alertHistory.pop()

  // Auto-repeat for CRITICAL until ACK'd
  if (level === 'CRITICAL') {
    log('🔁', 'yellow',
      `Auto-repeat aktif setiap ${REPEAT_INTERVAL_MS / 1000}s sampai /ack ${alertId}`)

    let repeatCount = 0
    const timer = setInterval(() => {
      if (!pendingAcks.has(alertId)) { clearInterval(timer); return }
      repeatCount++
      const repeatFrame = { ...frame, repeat: repeatCount }
      let reSent = 0
      for (const [, peer] of peers) {
        if (peer.subscribedLevels.has('CRITICAL')) {
          try { peer.conn.write(encode(repeatFrame)); reSent++ } catch { /* ignore */ }
        }
      }
      log('🔁', 'yellow', `Repeat #${repeatCount} — ${C.dim}[${alertId}]${C.reset} → ${reSent} peer`)
    }, REPEAT_INTERVAL_MS)

    pendingAcks.set(alertId, { timer, data: frame })
    log('💡', 'dim',
      `Untuk hentikan repeat: /ack ${alertId}`)
  }
}

// ─── ACK ────────────────────────────────────────────────────────────────────

function sendAck (alertId) {
  if (!alertId) { log('✕', 'red', 'Usage: /ack <alertId>'); return }

  // Stop local repeat timer
  if (pendingAcks.has(alertId)) {
    clearInterval(pendingAcks.get(alertId).timer)
    pendingAcks.delete(alertId)
    log('✅', 'green', `Repeat dihentikan untuk alert ${C.dim}${alertId}${C.reset}`)
  }

  // Broadcast ACK
  broadcast({ type: MSG.ACK, alertId, sender: myAlias })
  log('✅', 'green', `ACK dikirim untuk alert ${C.dim}${alertId}${C.reset}`)
}

// ─── Subscribe management ───────────────────────────────────────────────────

function updateSubscribe (levelArgs) {
  const requested = levelArgs.map(l => l.toUpperCase()).filter(l => LEVELS.includes(l))
  if (requested.length === 0) {
    log('✕', 'red', `Level tidak valid. Pilih dari: ${LEVELS.join(', ')}`)
    return
  }
  mySubscribe = new Set(requested)
  broadcast({ type: MSG.SUBSCRIBE, levels: [...mySubscribe] })
  log('🔔', 'magenta', `Subscribe diupdate → ${[...mySubscribe].join(', ')} — notifikasi dikirim ke ${peers.size} peer`)
}

// ─── Log file ───────────────────────────────────────────────────────────────

function appendLog (line) {
  try { fs.appendFileSync(LOG_FILE, `[${iso()}] ${line}\n`) } catch { /* ignore */ }
}

function printLog () {
  if (!fs.existsSync(LOG_FILE)) { log('ℹ', 'yellow', `Log belum ada: ${LOG_FILE}`); return }
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-15)
  process.stdout.write(`\r${C.bold}Log terakhir (${LOG_FILE}):${C.reset}\n`)
  for (const l of lines) process.stdout.write(`  ${C.dim}${l}${C.reset}\n`)
  process.stdout.write('> ')
}

// ─── History ────────────────────────────────────────────────────────────────

function printHistory () {
  if (alertHistory.length === 0) { log('ℹ', 'yellow', 'Belum ada alert diterima sesi ini.'); return }
  process.stdout.write(`\r${C.bold}Alert history (sesi ini):${C.reset}\n`)
  for (const [i, e] of alertHistory.slice(0, 15).entries()) {
    const cfg    = LEVEL_CFG[e.level] ?? LEVEL_CFG.INFO
    const ackTag = e.acked ? ` ${C.green}[ACK'd${e.ackedBy ? ' by ' + e.ackedBy : ''}]${C.reset}` : ''
    const dir    = e.sent ? `${C.dim}→ sent${C.reset}` : `${C.dim}← recv${C.reset}`
    process.stdout.write(
      `  ${C.dim}${(i + 1).toString().padStart(2)}.${C.reset} ` +
      `${cfg.badge} ${dir} ${C.cyan}${e.from}${C.reset}: ` +
      `${e.message.slice(0, 55)}${e.message.length > 55 ? '…' : ''}` +
      `${ackTag} ${C.dim}[${e.alertId}]${C.reset}\n`
    )
  }
  process.stdout.write('> ')
}

// ─── Pending ────────────────────────────────────────────────────────────────

function printPending () {
  if (pendingAcks.size === 0) {
    log('✅', 'green', 'Tidak ada CRITICAL alert yang menunggu ACK.')
    return
  }
  process.stdout.write(`\r${C.bold}${C.red}CRITICAL alerts menunggu ACK:${C.reset}\n`)
  for (const [id, { data }] of pendingAcks) {
    process.stdout.write(`  ${C.red}🚨${C.reset} ${C.dim}${id}${C.reset} — "${data.message}" → /ack ${id}\n`)
  }
  process.stdout.write('> ')
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function printHelp () {
  process.stdout.write(`
${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗
║           INTERCOM-ALERT  COMMANDS                   ║
╚══════════════════════════════════════════════════════╝${C.reset}

  ${C.yellow}/info <pesan>${C.reset}
      Kirim alert level INFO ke semua peer.

  ${C.yellow}/warn <pesan>${C.reset}
      Kirim alert level WARN ke semua peer.

  ${C.yellow}/critical <pesan>${C.reset}
      Kirim alert level CRITICAL (auto-repeat sampai di-ACK).

  ${C.yellow}/ack <alertId>${C.reset}
      Acknowledge CRITICAL alert — hentikan auto-repeat.

  ${C.yellow}/subscribe <level> [level...]${C.reset}
      Atur filter notifikasi. Contoh: /subscribe WARN CRITICAL
      Level tersedia: INFO  WARN  CRITICAL

  ${C.yellow}/pending${C.reset}
      Lihat CRITICAL alerts yang belum di-ACK.

  ${C.yellow}/history${C.reset}
      Riwayat alert sesi ini (terkirim & diterima).

  ${C.yellow}/peers${C.reset}
      Daftar peer dan filter subscribe mereka.

  ${C.yellow}/log${C.reset}
      Tampilkan 15 baris terakhir dari ${LOG_FILE}.

  ${C.yellow}/alias <nama>${C.reset}
      Ganti nama tampilan kamu.

  ${C.yellow}/help${C.reset}
      Tampilkan menu ini.

  ${C.yellow}/exit${C.reset}
      Keluar dengan bersih.

  ${C.dim}Termux notification: ${HAS_TERMUX ? C.green + 'AKTIF ✓' : C.yellow + 'TIDAK TERSEDIA (bukan Termux)'}${C.reset}
\n> `)
}

function printPeers () {
  if (peers.size === 0) { log('ℹ', 'yellow', 'Belum ada peer terhubung.'); return }
  process.stdout.write(`\r${C.bold}Peer terhubung:${C.reset}\n`)
  for (const [pid, peer] of peers) {
    const sub = [...peer.subscribedLevels].join(', ') || 'none'
    process.stdout.write(
      `  ${C.cyan}${shortId(pid)}${C.reset}  alias=${C.white}${peer.alias}${C.reset}  subscribe=[${sub}]\n`
    )
  }
  process.stdout.write('> ')
}

function handleCommand (line) {
  const raw = line.trim()
  if (!raw) return

  if (!raw.startsWith('/')) {
    log('ℹ', 'dim', 'Ketik /help untuk daftar perintah.')
    return
  }

  const parts = raw.slice(1).split(' ')
  const cmd   = parts[0].toLowerCase()
  const rest  = parts.slice(1).join(' ').trim()
  const args  = parts.slice(1)

  switch (cmd) {
    case 'info':
      if (!rest) { log('✕', 'red', 'Usage: /info <pesan>'); break }
      sendAlert('INFO', rest)
      break

    case 'warn':
      if (!rest) { log('✕', 'red', 'Usage: /warn <pesan>'); break }
      sendAlert('WARN', rest)
      break

    case 'critical':
      if (!rest) { log('✕', 'red', 'Usage: /critical <pesan>'); break }
      sendAlert('CRITICAL', rest)
      break

    case 'ack':
      sendAck(rest)
      break

    case 'subscribe':
      if (args.length === 0) { log('✕', 'red', 'Usage: /subscribe <INFO|WARN|CRITICAL> [...]'); break }
      updateSubscribe(args)
      break

    case 'pending':
      printPending()
      break

    case 'history':
      printHistory()
      break

    case 'peers':
      printPeers()
      break

    case 'log':
      printLog()
      break

    case 'alias':
      if (!rest) { log('✕', 'red', 'Usage: /alias <nama>'); break }
      myAlias = rest.slice(0, 24)
      log('✓', 'green', `Alias diubah ke "${myAlias}"`)
      break

    case 'help':
      printHelp()
      break

    case 'exit':
    case 'quit':
      log('✓', 'green', 'Keluar dari swarm…')
      // Clear all repeat timers
      for (const [, { timer }] of pendingAcks) clearInterval(timer)
      process.exit(0)
      break

    default:
      log('✕', 'yellow', `Perintah tidak dikenal: /${cmd}. Ketik /help.`)
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main () {
  const args    = process.argv.slice(2)
  let channel   = DEFAULT_CHANNEL
  let alias     = ''
  let subLevels = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel'   && args[i + 1]) channel   = args[++i]
    if (args[i] === '--alias'     && args[i + 1]) alias     = args[++i]
    if (args[i] === '--subscribe' && args[i + 1]) subLevels = args[++i].split(',').map(s => s.trim().toUpperCase())
  }

  myAlias = alias || `node-${crypto.randomBytes(2).toString('hex')}`

  if (subLevels) {
    mySubscribe = new Set(subLevels.filter(l => LEVELS.includes(l)))
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  process.stdout.write(`
${C.bold}${C.red}
   █████╗ ██╗     ███████╗██████╗ ████████╗
  ██╔══██╗██║     ██╔════╝██╔══██╗╚══██╔══╝
  ███████║██║     █████╗  ██████╔╝   ██║
  ██╔══██║██║     ██╔══╝  ██╔══██╗   ██║
  ██║  ██║███████╗███████╗██║  ██║   ██║
  ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝${C.reset}${C.dim} intercom-alert v${APP_VERSION}${C.reset}
${C.cyan}  Decentralized P2P Alert & Notification System${C.reset}
${C.dim}  Intercom Vibe Competition · Trac Network${C.reset}

`)

  // ── Swarm init ────────────────────────────────────────────────────────────
  swarm    = new Hyperswarm()
  myPeerId = b4a.toString(swarm.keyPair.publicKey, 'hex')

  log('⚡', 'green', `Peer ID    : ${shortId(myPeerId)}`)
  log('⚡', 'green', `Alias      : ${myAlias}`)
  log('⚡', 'green', `Channel    : ${channel}`)
  log('⚡', 'green', `Subscribe  : ${[...mySubscribe].join(', ')}`)
  log('⚡', 'green', `Log file   : ${LOG_FILE}`)
  log('⚡', HAS_TERMUX ? 'green' : 'yellow',
    `Termux notif: ${HAS_TERMUX ? 'AKTIF ✓' : 'tidak tersedia (bukan Termux)'}`)

  swarm.on('connection', handleConnection)

  const topic = topicFromString(channel)
  const disc  = swarm.join(topic, { server: true, client: true })
  await disc.flushed()

  log('✓', 'green', 'Bergabung ke DHT — menunggu peer. Ketik /help untuk mulai.\n')

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log('⟳', 'yellow', 'Meninggalkan swarm…')
      for (const [, { timer }] of pendingAcks) clearInterval(timer)
      await swarm.destroy()
      process.exit(0)
    })
  }

  // ── CLI ───────────────────────────────────────────────────────────────────
  const rl = readline.createInterface({
    input   : process.stdin,
    output  : process.stdout,
    prompt  : '> ',
    terminal: true,
  })

  rl.prompt()
  rl.on('line',  line => { handleCommand(line); rl.prompt() })
  rl.on('close', async () => {
    for (const [, { timer }] of pendingAcks) clearInterval(timer)
    await swarm.destroy()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
