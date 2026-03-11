# Customer Guide

This guide is for standard customers or VIP users who manage only their own workspace.

## 1. What you need before logging in

Prepare these items:

- SSH host or IP for each streaming server
- SSH port, username, and password
- A clear group structure for your servers
- One or more unique match terms for each live stream
- Optional explicit restart commands such as `systemctl restart stream-room-001`

This version does **not** require you to create:

- YouTube API keys
- Google OAuth credentials
- YouTube Live Streaming API authorization

## 2. First access

If your provider gave you a CDK:

1. Open the dashboard URL.
2. Use the CDK activation form.
3. Create your workspace admin username and password.
4. Then log in through the customer login entry.

If your provider created the account for you, just use the customer login form.

Recommended direct routes:

- customer login: `/customer/login`
- CDK activation: `/redeem`
- platform admin login: `/admin/login`

The public root `/` is intentionally customer-facing and does not show the super-admin entry card.

## 3. Plan your groups first

The dashboard is designed for:

- Group
- Server
- Stream

Recommended grouping patterns:

- by region
- by project
- by business line
- by primary/backup role

If you place dozens of servers into one flat bucket, daily checks become harder.

## 4. Add a server

Open **Server Management** and fill:

- Group
- Server label
- Host
- SSH port
- SSH username
- SSH password
- Optional notes

Use labels that clearly describe the server at a glance.

## 4A. Auto-import currently running streams over SSH

If the server is already live, you can avoid manual re-entry:

1. Save the server first.
2. Use **SSH Discover Current Streams** in the server page.
3. The platform logs in to the server, scans running `ffmpeg` processes, detects YouTube stream keys and media paths, and imports them into **Stream Management** automatically.

This is useful when you are onboarding servers that are already streaming.

## 5. Add a stream

Open **Stream Management** and fill:

- Server
- Stream label
- Media filename or absolute media path
- YouTube stream key
- Match terms
- Optional restart command
- Restart log path
- Cooldown seconds
- Restart window seconds
- Max restarts inside the window
- Verification delay

If you provide only:

- a media filename, for example `lbo2.mp4`
- a YouTube stream key

the dashboard can generate the restart command for you automatically.

If you leave the stream label empty, the filename is used as the default label.

## 5A. One-click start from the web UI

For a new stream, the fastest path is:

1. Select the target server
2. Enter the media filename or full path
3. Enter the YouTube stream key
4. Click **Save and Start**

The platform will create the stream, generate the `ffmpeg` recovery command, store match terms, and trigger immediate start.

## 6. Match-term rules

Match terms are how the system identifies the correct `ffmpeg` process.

Good examples:

```text
/root/1.mp4
```

```text
live2/abcd-efgh-ijkl
```

```text
abcd-efgh-ijkl
```

Bad examples:

```text
ffmpeg
youtube
rtmp
```

Use terms that are unique to one stream.

## 7. Restart strategy

Two valid patterns:

1. Let the watchdog learn the healthy `ffmpeg` command from a currently running process.
2. Provide an explicit recovery command yourself.

The second pattern is more stable for long-term operations:

```bash
systemctl restart stream-room-001
```

or

```bash
bash /root/restart-room-001.sh
```

If you use the built-in filename + stream-key mode, the platform generates a command in this pattern automatically:

```bash
nohup ffmpeg -stream_loop -1 -re -i '/root/file.mp4' -c:v copy -c:a copy -f flv 'rtmp://a.rtmp.youtube.com/live2/your-key' > /dev/null 2>&1 &
```

## 8. How to read the dashboard

Prioritize these areas in order:

1. Issue-first panels
2. Stream matrix
3. Group explorer
4. Event log

Do not use the event feed as your main operational view.

## 9. Common issues

### Server shows offline

Check:

- SSH host
- SSH port
- SSH username/password
- firewall rules

### Stream is never detected

Check:

- match term uniqueness
- whether the term appears in the remote `ffmpeg` command
- whether the process is actually running

### Auto-recovery fails

Check:

- whether a valid restart command exists
- whether the watchdog has already learned the real `ffmpeg` command
- whether cooldown or restart-window rules are too strict
