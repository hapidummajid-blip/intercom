# SKILL — intercom-alert

> Instruksi agent untuk mengoperasikan dan berinteraksi dengan **intercom-alert**.  
> Mengikuti konvensi Intercom SKILL.md dari Trac Systems.

---

## Apa Itu Aplikasi Ini?

**intercom-alert** adalah sistem notifikasi dan peringatan P2P tanpa server yang dibangun di atas Hyperswarm / Trac Network.

Setiap peer bisa mengirim alert bertipe **INFO**, **WARN**, atau **CRITICAL** ke semua peer yang terhubung di channel yang sama. Peer dapat mengatur filter subscribe untuk hanya menerima tipe yang mereka pedulikan. Alert CRITICAL akan otomatis diulang sampai salah satu peer mengirim ACK.

---

## Level Alert & Perilakunya

| Level | Icon | Warna | Auto-Repeat | Termux Sound |
|---|---|---|---|---|
| `INFO` | ℹ️ | Biru | ✗ | ✗ |
| `WARN` | ⚠️ | Kuning | ✗ | ✗ |
| `CRITICAL` | 🚨 | Merah (highlight) | ✓ setiap 15 detik | ✓ dengan vibrate |

---

## Kebutuhan Runtime

| Kebutuhan | Versi / Catatan |
|---|---|
| Node.js | ≥ 18.0.0 |
| Pear Runtime | opsional, direkomendasikan |
| Termux (Android) | opsional — untuk push notification |
| termux-api | opsional — `pkg install termux-api` untuk notif |

---

## Checklist First-Run

1. Clone atau copy repository.
2. Jalankan `npm install` di root proyek.
3. Di Termux, install termux-api untuk notifikasi: `pkg install termux-api`.
4. Mulai dengan `node index.js` atau `pear run . alert1`.
5. Alias acak seperti `node-a3f2` otomatis diberikan. Ganti dengan `--alias NamaKamu`.
6. Bagikan **channel name** ke semua peer yang perlu menerima alert.

---

## Referensi CLI

| Perintah | Keterangan |
|---|---|
| `/info <pesan>` | Kirim alert INFO |
| `/warn <pesan>` | Kirim alert WARN |
| `/critical <pesan>` | Kirim alert CRITICAL (auto-repeat) |
| `/ack <alertId>` | Acknowledge CRITICAL — hentikan repeat |
| `/subscribe <level...>` | Atur filter: `/subscribe WARN CRITICAL` |
| `/pending` | Lihat CRITICAL alerts yang belum di-ACK |
| `/history` | Riwayat alert sesi ini |
| `/peers` | Daftar peer + filter subscribe mereka |
| `/log` | 15 baris terakhir dari `alert-log.txt` |
| `/alias <nama>` | Ganti nama tampilan |
| `/help` | Menu lengkap |
| `/exit` | Keluar dengan bersih |

---

## Opsi Launch

```bash
node index.js [--channel <nama>] [--alias <nama>] [--subscribe <level,...>]
```

| Flag | Default | Fungsi |
|---|---|---|
| `--channel` | `intercom-alert-v1-global` | Nama channel DHT |
| `--alias` | `node-<4 hex>` | Nama tampilan |
| `--subscribe` | `INFO,WARN,CRITICAL` | Filter level awal (comma-separated) |

### Contoh

```bash
# Semua level, channel publik
node index.js --alias server-prod

# Hanya terima CRITICAL
node index.js --alias on-call --subscribe CRITICAL

# Channel privat tim
node index.js --channel ops-team-2025 --alias monitoring-bot

# Pear runtime
pear run . alert1 --channel ops-team-2025 --alias alice
```

---

## Alur Auto-Repeat CRITICAL

```
Sender                          Receiver
  │                                 │
  │── /critical "DB down!" ────────>│ (tampil + notif Termux)
  │                                 │
  │  (15 detik)                     │
  │── ALERT repeat #1 ─────────────>│ (tampil lagi)
  │                                 │
  │  (15 detik)                     │
  │── ALERT repeat #2 ─────────────>│ (tampil lagi)
  │                                 │
  │<─── /ack <alertId> ─────────────│
  │── ACK broadcast ───────────────>│
  │  (repeat BERHENTI)              │
```

- Siapa pun di channel bisa mengirim ACK — tidak harus si penerima.
- ACK broadcast ke semua peer sehingga semua node tahu alert sudah ditangani.
- Repeat hanya berjalan di sisi **pengirim** (initiator menyimpan timer lokal).

---

## Protokol Wire (NDJSON)

### `INFO` — Peer Announce
```json
{
  "type": "INFO",
  "alias": "server-prod",
  "version": "1.0.0",
  "subscribe": ["WARN", "CRITICAL"]
}
```

### `ALERT` — Kirim Alert
```json
{
  "type": "ALERT",
  "alertId": "a1b2c3d4",
  "level": "CRITICAL",
  "message": "Database connection lost!",
  "sender": "server-prod",
  "repeat": 2
}
```
Field `repeat` hanya ada pada pengiriman ulang (tidak ada di pengiriman pertama).

### `ACK` — Acknowledge
```json
{
  "type": "ACK",
  "alertId": "a1b2c3d4",
  "sender": "on-call-alice"
}
```

### `SUBSCRIBE` — Update Filter
```json
{
  "type": "SUBSCRIBE",
  "levels": ["WARN", "CRITICAL"]
}
```

---

## Format Filter Subscribe

```bash
# Hanya terima CRITICAL
/subscribe CRITICAL

# Terima WARN dan CRITICAL (tidak INFO)
/subscribe WARN CRITICAL

# Terima semua
/subscribe INFO WARN CRITICAL
```

Filter subscribe dikomunikasikan ke semua peer sehingga:
- Pengirim tahu level mana yang akan diterima tiap peer
- Alert hanya dikirim ke peer yang subscribe ke level tersebut

---

## Format File Log

Setiap alert disimpan ke `alert-log.txt`:
```
[ISO timestamp] [SENT][CRITICAL] msg="DB down" id=a1b2c3d4 recipients=3
[ISO timestamp] [CRITICAL] from=server-prod msg="DB down" id=a1b2c3d4
[ISO timestamp] [INFO] from=deploy-bot msg="Deploy v2.1 sukses" id=9b3c1d2e
```

---

## Integrasi Agent / Otomasi

```bash
# Kirim CRITICAL dari skrip shell
echo "/critical Server CPU 100%!" | node index.js --alias monitor-bot --channel ops

# Kirim INFO dari CI/CD pipeline
echo "/info Deploy v2.1 berhasil" | node index.js --alias ci-bot --channel ops

# Filter stdout untuk alert masuk
node index.js --alias receiver | grep "CRITICAL\|WARN"
```

---

## Notifikasi Termux

Jika `termux-notification` tersedia (Android + Termux API):
- Alert `INFO` & `WARN`: notifikasi standar
- Alert `CRITICAL`: notifikasi + vibrate 1 detik + LED merah

Install Termux API:
```bash
pkg install termux-api -y
# Aktifkan juga app "Termux:API" dari F-Droid
```

---

## Troubleshooting

| Gejala | Kemungkinan Penyebab | Solusi |
|---|---|---|
| Tidak ada peer | Firewall UDP | Izinkan UDP keluar |
| Notifikasi tidak muncul | termux-api belum install | `pkg install termux-api` |
| Repeat tidak berhenti | ACK tidak sampai (network) | Kirim `/ack <id>` lagi |
| `ERR_MODULE_NOT_FOUND` | Belum `npm install` | `npm install` |
| Crash di Termux | Node terlalu lama | `pkg upgrade nodejs` |

---

*intercom-alert — Intercom Vibe Competition Submission*  
*Trac Address: [INSERT_YOUR_TRAC_ADDRESS_HERE]*
