# kickwise.engine

Prediction-Engine für Kickwise.

> **Phase-1-Status**: Skeleton — startet einen Fastify-Server mit `/health`-Endpoint und sonst nichts. Wird in Phase 2 erweitert.

## Geplanter Funktionsumfang (Phase 2)

- Lese-Zugriff auf BigQuery (`matches`, `xg_match_data`, `player_match_stats`)
- Poisson-Modell auf Team-xG → `predictions` Tabelle
- Spieler-Erwartungs-Modell: `prob_starts × projected_minutes × xG-zu-Kickbase-Punkte-Formel` → `player_projections`
- HTTP-Endpoints, die der Playmaker für Match-Detail-Views aufruft
- Geplante Endpoints:
  - `POST /api/v1/predictions/run?matchday=X` — triggert einen Modell-Run
  - `GET  /api/v1/predictions/:matchId` — aktuellste Prediction für ein Match
  - `GET  /api/v1/projections/:matchId` — Player-Projektionen für ein Match

## Geplanter Funktionsumfang (Phase 4)

- 3-2-1-Manager-H2H pro Spieltag berechnen → `manager_h2h_results`
- Saison-Standings nach Wettkampfpunkten + Tiebreaker

## Lokal starten

```bash
cp .env.example .env.local
npm install
npm run dev    # http://localhost:3002/health
```
