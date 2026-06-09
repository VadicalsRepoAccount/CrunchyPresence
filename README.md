# CrunchyPresence

Discord Rich Presence integration for Crunchyroll with live episode tracking, progress timestamps, playback status, and support for all Crunchyroll profiles. (Crunchyroll doesn't support Sub-Profiles under the same subscripton)


```text
Browser Extension  ──WebSocket──▶  Python Bridge  ──IPC──▶  Discord
  (reads page)        port 6969      (rpc.py)               Rich Presence
```

> Crunchyroll and its logo are trademarks of Crunchyroll, LLC.
>
> This project is not affiliated with, endorsed by, or sponsored by Crunchyroll.

---

## Features

* Displays series name and episode title
* Season and episode number support
* Live progress timestamps (elapsed / remaining)
* Play / Pause status indicator
* "Watch on Crunchyroll" button in Discord
* Works on all Crunchyroll profiles under the same subscription
* Automatically clears presence when playback stops or the tab closes
* Lightweight local WebSocket bridge
* No account login, cookies, or API keys required

---

## Requirements

* Python 3.10+
* Discord Desktop App
* Firefox Developer Edition or Chromium-based browser
* Active Crunchyroll playback

---

## Quick Start

### 1 · Create a Discord Application

1. Open https://discord.com/developers/applications
2. Click **New Application**
3. Name it `Crunchyroll`
4. Open **General Information**
5. Copy the **Application ID**

#### Optional Art Assets

Under **Rich Presence → Art Assets**, upload:

| Asset Key          | Purpose                |
| ------------------ | ---------------------- |
| `crunchyroll_logo` | Large Crunchyroll logo |
| `play_icon`        | Playing indicator      |
| `pause_icon`       | Paused indicator       |

---

### 2 · Configure the Bridge

Install dependencies:

```bash
cd CrunchyPresence/bridge
pip install -r requirements.txt
```

Open `rpc.py` and set your application ID:

```python
CLIENT_ID = "YOUR_DISCORD_APPLICATION_ID"
```

Start the bridge:

```bash
python rpc.py
```

Expected output:

```text
12:34:56 INFO CrunchyPresence.ws — WebSocket bridge listening on ws://127.0.0.1:6969
12:34:56 INFO CrunchyPresence — Discord RPC connected.
```

Leave the bridge running while watching Crunchyroll.

---

### 3 · Install the Extension

#### Chrome / Edge

1. Open:

   ```text
   chrome://extensions
   ```

2. Enable **Developer Mode**

3. Click **Load Unpacked**

4. Select the `extension/` folder

---

#### Firefox Developer Edition

CrunchyPresence can be installed permanently without publishing it to Mozilla Add-ons.

##### Disable Signature Enforcement

Open:

```text
about:config
```

Search for:

```text
xpinstall.signatures.required
```

Set it to:

```text
false
```

Restart Firefox Developer Edition.

##### Package the Extension

Open the `extension/` folder and select:

```text
manifest.json
background.js
content.js
popup.html
popup.css
popup.js
icons/
```

Create a ZIP archive containing those files.

Rename:

```text
CrunchyPresence.zip
```

to:

```text
CrunchyPresence.xpi
```

##### Install

Open:

```text
about:addons
```

Click:

```text
⚙ → Install Add-on From File...
```

Select:

```text
CrunchyPresence.xpi
```

The extension should remain installed across browser restarts.

##### Required Manifest Setting

Firefox requires a Gecko extension ID:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "crunchypresence"
  }
}
```

---

### 4 · Start Watching

Open any Crunchyroll episode:

```text
https://www.crunchyroll.com/watch/...
```

Within a few seconds your Discord Rich Presence should update automatically.

---

## Architecture

```text
extension/
├─ manifest.json
├─ background.js
├─ content.js
├─ popup.html
├─ popup.css
├─ popup.js
└─ icons/

bridge/
├─ rpc.py
├─ websocket_server.py
└─ adapters/
   └─ crunchyroll.py
```

### Extension

| File              | Purpose                              |
| ----------------- | ------------------------------------ |
| manifest.json     | Firefox extension manifest           |
| content.js        | Reads playback data from Crunchyroll |
| background.js     | Relays data to the local bridge      |
| popup.html/css/js | Extension interface                  |

### Bridge

| File                    | Purpose                                      |
| ----------------------- | -------------------------------------------- |
| rpc.py                  | Main application entry point                 |
| websocket_server.py     | Local WebSocket server                       |
| adapters/crunchyroll.py | Converts page data into Discord RPC payloads |

---

## Troubleshooting

| Problem                                        | Solution                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Bridge offline                                 | Ensure `python rpc.py` is running                                       |
| Discord status not updating                    | Verify Discord Desktop is open                                          |
| InvalidPipe error                              | Start Discord before the bridge                                         |
| Extension won't install                        | Verify `xpinstall.signatures.required` is disabled                      |
| Invalid XPI: Cannot find id for addon          | Add a Gecko extension ID to `manifest.json`                             |
| Invalid XPI: does not contain a valid manifest | Ensure `manifest.json` is valid JSON and located at the root of the XPI |
| Presence not updating                          | Refresh the Crunchyroll tab and verify the bridge is connected          |
| No episode detected                            | Crunchyroll may have changed page structure                             |

---

## Security

CrunchyPresence communicates only with:

```text
ws://127.0.0.1:6969
```

No data is sent to external servers.

All playback information remains local between:

```text
Crunchyroll → Extension → Python Bridge → Discord
```

---

## License

MIT License
