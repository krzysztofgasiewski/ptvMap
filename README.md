# ptvmap

A live map of Warsaw public transport vehicles. Shows buses and trams on a map, updated every 10 seconds using the [Open Data Warsaw API](https://dane.um.warszawa.pl).

## Requirements

- Node.js 18+
- pnpm
- An API key from [dane.um.warszawa.pl](https://dane.um.warszawa.pl)

## Setup

```bash
pnpm install
```

Create a `.env` file:

```
API_KEY=your_api_key_here
PORT=3000 # Optional
```

Then start the server:

```bash
node index.js
```

Open `http://localhost:3000` in your browser.

## Options

| Variable    | Default | Description                                                  |
| ----------- | ------- | ------------------------------------------------------------ |
| `PORT`      | `3000`  | Port to listen on                                            |
| `API_KEY`   | -       | Open Data Warsaw API key (required)                          |
| `LOG_LEVEL` | `info`  | Log verbosity - `trace`, `debug`, `info`, `warn`, or `error` |

## API

- `GET /api/vehicles?type=1` - trams
- `GET /api/vehicles?type=2` - buses
- `GET /api/health` - server status and cache stats
