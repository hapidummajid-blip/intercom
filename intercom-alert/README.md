# intercom-alert 🔔

> **Decentralized P2P Alert & Notification System**  
> Submission untuk **Intercom Vibe Competition** — dibangun di atas Trac Network / Hyperswarm

[![Node ≥ 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Pear Runtime](https://img.shields.io/badge/pear-compatible-blue)](https://pears.com)
[![Termux Ready](https://img.shields.io/badge/termux-ready-orange)](https://termux.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

---

## Apa Itu intercom-alert?

**intercom-alert** memungkinkan sekelompok peer mengirim dan menerima notifikasi peringatan secara real-time tanpa server, tanpa cloud, murni P2P.

Cocok untuk:
- 🖥️ **DevOps** — monitoring server tanpa dashboard terpusat
- 👨‍👩‍👧‍👦 **Tim kecil** — koordinasi insiden secara langsung antar device
- 📱 **Mobile-first** — notifikasi push ke Android via Termux API

```
┌──────────────────┐                              ┌──────────────────┐
│  server-prod     │  ── CRITICAL: DB down! ────► │  on-call-alice   │
│  node index.js   │  ◄── ACK ──────────────────  │  node index.js   │
└──────────────────┘    Hyperswarm P2P · Noise     └──────────────────┘
         │                                                  │
         └──────────── shared channel topic ────────────────┘
```

---

## Fitur Utama

- **3 level alert**: `INFO` · `WARN` · `CRITICAL`
- **Filter subscribe per peer** — hanya terima yang kamu butuhkan
- **Auto-repeat CRITICAL** — ulang setiap 15 detik sampai di-ACK
- **ACK broadcast** — semua peer tahu alert sudah ditangani
- **Termux push notification** — notif + vibrate di Android
- **File log otomatis** — semua alert tersimpan di `alert-log.txt`
- **Zero server** — semua komunikasi P2P via Hyperswarm DHT

---

## Instalasi

### Standard (Node.js)

```bash
git clone https://github.com/USERNAME_KAMU/intercom-alert.git
cd intercom-alert
npm install
node index.js --alias namaKamu
```

### Dengan Pear Runtime

```bash
npm install -g pear
cd intercom-alert
npm install
pear run . alert1
```

---

## Termux (Android) — Quick Start

```bash
# Update & install Node.js
pkg update && pkg upgrade -y
pkg install nodejs git termux-api -y

# Clone repo
git clone https://github.com/USERNAME_KAMU/intercom-alert.git
cd intercom-alert
npm install

# Jalankan
node index.js --alias namaKamu
```

> **Penting:** Install juga app **Termux:API** dari F-Droid agar notifikasi push bekerja.

---

## Cara Pakai

### Kirim Alert

```
> /info Deploy v2.1 selesai
> /warn Disk usage 85% di server-01
> /critical Database connection lost!
```

### Acknowledge CRITICAL

```
> /ack a1b2c3d4
```

### Atur Filter Subscribe

```
# Hanya terima CRITICAL (cocok untuk on-call malam)
> /subscribe CRITICAL

# Terima WARN dan CRITICAL
> /subscribe WARN CRITICAL

# Terima semua level
> /subscribe INFO WARN CRITICAL
```

### Perintah Lain

```
> /pending        # CRITICAL yang belum di-ACK
> /history        # Riwayat alert sesi ini
> /peers          # Daftar peer + filter mereka
> /log            # Isi file alert-log.txt
> /alias DevOps   # Ganti nama tampilan
> /help           # Menu lengkap
> /exit           # Keluar
```

---

## Contoh Skenario

### Skenario 1: Server monitoring tim kecil

```bash
# Di server produksi
node index.js --alias server-prod --channel ops-team

# Di laptop DevOps
node index.js --alias devops-budi --channel ops-team

# Di HP on-call (Termux)
node index.js --alias on-call --channel ops-team --subscribe CRITICAL
```

Saat server down:
```
[server-prod]  > /critical DB replica lag > 30s!
[on-call]      🚨 CRITICAL dari server-prod: DB replica lag > 30s!
               → Ketik /ack a1b2c3d4 untuk acknowledge
[on-call]      > /ack a1b2c3d4
[server-prod]  ✅ ACK diterima dari on-call — repeat berhenti.
```

### Skenario 2: CI/CD pipeline notification

```bash
# Dari script shell
echo "/info Deploy v3.2 berhasil ke staging" | \
  node index.js --alias ci-bot --channel dev-team
```

---

## Arsitektur

```
index.js
├── Hyperswarm (DHT discovery + Noise encryption)
├── Level system (INFO / WARN / CRITICAL)
├── Subscribe filter (per peer, dikomunikasikan saat connect)
├── Auto-repeat engine (setInterval per CRITICAL alert)
├── ACK system (broadcast + stop timer lokal)
├── Termux notification (exec termux-notification)
├── Alert history (in-memory, 50 entri terakhir)
├── File logger (append alert-log.txt)
└── CLI (readline interactive prompt)
```

---

## Protokol Wire

Semua pesan adalah newline-delimited JSON via stream terenkripsi Noise:

```jsonc
// Kirim alert CRITICAL
{"type":"ALERT","alertId":"a1b2c3d4","level":"CRITICAL","message":"DB down!","sender":"server-prod"}

// ACK
{"type":"ACK","alertId":"a1b2c3d4","sender":"on-call"}

// Update subscribe filter
{"type":"SUBSCRIBE","levels":["WARN","CRITICAL"]}
```

---

## File Log

Setiap alert otomatis tersimpan ke `alert-log.txt`:

```
[2025-08-15T10:22:01Z] [SENT][CRITICAL] msg="DB down!" id=a1b2c3d4 recipients=2
[2025-08-15T10:22:01Z] [CRITICAL] from=server-prod msg="DB down!" id=a1b2c3d4
[2025-08-15T10:25:44Z] [INFO] from=ci-bot msg="Deploy sukses" id=9b3c1d2e
```

---

## Lisensi

MIT — lihat [LICENSE](LICENSE)

---

## Trac Address

trac1k2uqxn0rlgf8nwupfu3j786kjc608rlmsefked2zvvujy26hf2cssyn8q2

---

*Dibangun dengan ♥ untuk Intercom Vibe Competition — Trac Network*
