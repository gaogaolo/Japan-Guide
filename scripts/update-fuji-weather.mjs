#!/usr/bin/env node
/**
 * Produces the small, static weather feed consumed by index.html.
 * Sources:
 *   - JMA Yamanashi forecast (official, East/Fuji Five Lakes area)
 *   - Open-Meteo forecast for Kawaguchiko (cloud / rain / wind inputs)
 *
 * This is a planning signal, never a guarantee of summit visibility. The
 * website links the Yamanashi tourism live cameras for the final decision.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(decodeURIComponent(path.dirname(new URL(import.meta.url).pathname)), '..');
const OUTPUT = path.join(ROOT, 'data', 'fuji-status.json');
const JMA_URL = 'https://www.jma.go.jp/bosai/forecast/data/forecast/190000.json';
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast?latitude=35.4894&longitude=138.6883&timezone=Asia%2FTokyo&forecast_days=7&daily=weather_code,precipitation_probability_max,cloud_cover_mean,wind_speed_10m_max';
const SOURCE_LINKS = {
  jma: 'https://www.data.jma.go.jp/multi/yoho/yoho_detail.html?code=190020&lang=en',
  camera: 'https://www.yamanashi-kankou.jp/fujisanwatcher/live/index.html',
  model: 'https://open-meteo.com/'
};

const isoDate = value => String(value || '').slice(0, 10);
const toNumber = value => value === '' || value == null ? null : Number(value);
const areaMatch = area => area?.code === '190020' || /富士五湖|Fuji Five Lakes/.test(area?.name || '');

function pickJmaForecast(payload) {
  const byDate = new Map();
  for (const report of payload) {
    for (const series of report.timeSeries || []) {
      const area = (series.areas || []).find(entry => areaMatch(entry.area));
      if (!area) continue;
      (series.timeDefines || []).forEach((time, index) => {
        const date = isoDate(time);
        if (!date) return;
        const current = byDate.get(date) || {};
        if (area.weathers?.[index]) current.weather = area.weathers[index];
        if (area.weatherCodes?.[index]) current.weatherCode = area.weatherCodes[index];
        if (area.pops?.[index] !== undefined) current.pop = toNumber(area.pops[index]);
        if (area.reliabilities?.[index]) current.reliability = area.reliabilities[index];
        byDate.set(date, current);
      });
    }
  }
  return byDate;
}

function visibilityDecision({ precipitationProbability, cloudCover, windSpeed, weatherCode }) {
  let score = 100;
  score -= Math.min(42, (precipitationProbability ?? 50) * 0.7);
  score -= Math.min(42, (cloudCover ?? 60) * 0.48);
  score -= Math.min(16, Math.max(0, (windSpeed ?? 12) - 8) * 1.3);
  if ([61, 63, 65, 80, 81, 82, 95, 96, 99].includes(weatherCode)) score -= 18;
  score = Math.round(Math.max(0, Math.min(100, score)));
  const verdict = score >= 68 ? 'go' : score >= 42 ? 'maybe' : 'skip';
  return { score, verdict };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Japan-Guide-Fuji-Weather/1.0' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function main() {
  const [jma, model] = await Promise.all([fetchJson(JMA_URL), fetchJson(OPEN_METEO_URL)]);
  const jmaByDate = pickJmaForecast(jma);
  const daily = model.daily;
  if (!daily?.time?.length) throw new Error('Open-Meteo returned no daily forecast');
  const days = daily.time.map((date, index) => {
    const precipitationProbability = toNumber(daily.precipitation_probability_max?.[index]);
    const cloudCover = toNumber(daily.cloud_cover_mean?.[index]);
    const windSpeed = toNumber(daily.wind_speed_10m_max?.[index]);
    const weatherCode = toNumber(daily.weather_code?.[index]);
    const jmaDay = jmaByDate.get(date) || {};
    const result = visibilityDecision({ precipitationProbability, cloudCover, windSpeed, weatherCode });
    return {
      date,
      ...result,
      precipitationProbability,
      cloudCover,
      windSpeed,
      weatherCode,
      jma: jmaDay.weather ? { weather: jmaDay.weather, weatherCode: jmaDay.weatherCode || null, precipitationProbability: jmaDay.pop ?? null, reliability: jmaDay.reliability || null } : null
    };
  });
  const output = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    location: { name: 'Kawaguchiko / Fuji Five Lakes', latitude: 35.4894, longitude: 138.6883, timezone: 'Asia/Tokyo' },
    methodology: 'JMA official area forecast is shown when available. Recommendation score combines numerical precipitation probability, mean cloud cover and maximum wind; it is a planning aid only.',
    sources: SOURCE_LINKS,
    days
  };
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  const temporary = `${OUTPUT}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`);
  await rename(temporary, OUTPUT);
  console.log(`Updated ${path.relative(ROOT, OUTPUT)} with ${days.length} forecast days.`);
}

main().catch(async error => {
  console.error(`Fuji weather update failed: ${error.message}`);
  process.exitCode = 1;
});
