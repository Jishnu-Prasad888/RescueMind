"""
agent_tools.py
==============
One LangChain Tool per data source.
The orchestrator LLM picks which tools to call based on the query.

Tools:
  search_live_news         – disaster news (RSS + NewsAPI)
  search_government_alerts – NDMA / FEMA / USGS alerts
  get_weather_report       – OpenWeatherMap live conditions + alerts
  search_instruction_manual – PDF vector store (pre-indexed)
"""

import os
import logging
from typing import ClassVar, Optional, Type
from pydantic import BaseModel, Field

from langchain_core.tools import BaseTool
from langchain_core.documents import Document
from langchain_community.vectorstores import Chroma
from langchain_huggingface import HuggingFaceEmbeddings

import feedparser
import httpx
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _doc_to_dict(doc: Document) -> dict:
    return {
        "content": doc.page_content,
        "title": doc.metadata.get("title", ""),
        "source_type": doc.metadata.get("source_type", ""),
        "url": doc.metadata.get("url", ""),
        "published_at": doc.metadata.get("published_at", ""),
        "location": doc.metadata.get("location", ""),
    }


# ---------------------------------------------------------------------------
# Tool 1: Live News
# ---------------------------------------------------------------------------

class NewsToolInput(BaseModel):
    query: str = Field(description="Disaster-related search query for news articles")
    max_results: int = Field(default=8, description="Max news articles to return")


class LiveNewsTool(BaseTool):
    """
    Searches live disaster news from RSS feeds and NewsAPI.
    Use this when the query is about recent events, ongoing incidents,
    breaking news, or current disaster situations.
    """
    name: str = "search_live_news"
    description: str = (
        "Search live disaster news from RSS feeds (ReliefWeb, GDACS) and NewsAPI. "
        "Use for: recent events, ongoing disasters, breaking news, incident reports. "
        "Input: a search query string. Returns latest relevant news articles."
    )
    args_schema: Type[BaseModel] = NewsToolInput

    RSS_FEEDS: ClassVar[list] = [
        "https://feeds.reliefweb.int/rss/disasters",
        "https://www.gdacs.org/xml/rss.xml",
    ]

    def _run(self, query: str, max_results: int = 8) -> list[dict]:
        import asyncio
        return asyncio.get_event_loop().run_until_complete(
            self._arun(query, max_results)
        )

    async def _arun(self, query: str, max_results: int = 8) -> list[dict]:
        docs = []
        query_terms = set(query.lower().split())

        for feed_url in self.RSS_FEEDS:
            try:
                feed = feedparser.parse(feed_url)
                for entry in feed.entries[:30]:
                    text = getattr(entry, "summary", "") or getattr(entry, "description", "")
                    if not text:
                        continue
                    # Simple relevance filter
                    entry_terms = set(text.lower().split())
                    if query_terms & entry_terms:
                        docs.append({
                            "content": text[:600],
                            "title": entry.get("title", ""),
                            "source_type": "news_rss",
                            "url": entry.get("link", ""),
                            "published_at": entry.get("published", _now()),
                            "location": "",
                        })
            except Exception as exc:
                logger.warning(f"RSS fetch error: {exc}")

        # Enrich with NewsAPI if key is set
        api_key = os.environ.get("NEWSAPI_KEY")
        if api_key:
            try:
                async with httpx.AsyncClient(timeout=12) as client:
                    resp = await client.get(
                        "https://newsapi.org/v2/everything",
                        params={
                            "q": query + " disaster",
                            "sortBy": "publishedAt",
                            "language": "en",
                            "pageSize": 15,
                            "apiKey": api_key,
                        },
                    )
                    resp.raise_for_status()
                    for art in resp.json().get("articles", []):
                        content = art.get("content") or art.get("description") or ""
                        if content:
                            docs.append({
                                "content": content[:600],
                                "title": art.get("title", ""),
                                "source_type": "news_api",
                                "url": art.get("url", ""),
                                "published_at": art.get("publishedAt", _now()),
                                "location": "",
                            })
            except Exception as exc:
                logger.warning(f"NewsAPI error: {exc}")

        # Sort by recency (best-effort), deduplicate, trim
        seen_urls = set()
        unique = []
        for d in docs:
            url = d.get("url", "")
            if url not in seen_urls:
                seen_urls.add(url)
                unique.append(d)

        logger.info(f"[NewsTool] '{query}' → {len(unique[:max_results])} articles")
        return unique[:max_results]


# ---------------------------------------------------------------------------
# Tool 2: Government Alerts
# ---------------------------------------------------------------------------

class GovAlertToolInput(BaseModel):
    query: str = Field(description="Query about official government disaster alerts or warnings")
    location: Optional[str] = Field(default=None, description="Specific location or region to filter")


class GovernmentAlertTool(BaseTool):
    """
    Fetches live official disaster alerts from NDMA, FEMA, USGS, NWS.
    Use this for: official warnings, evacuation orders, emergency declarations,
    seismic events, national/state-level alerts.
    """
    name: str = "search_government_alerts"
    description: str = (
        "Fetch official government disaster alerts from NDMA India, FEMA, USGS earthquakes, "
        "and National Weather Service. Use for: official warnings, evacuation orders, "
        "emergency declarations, seismic reports. Returns structured alert objects."
    )
    args_schema: Type[BaseModel] = GovAlertToolInput

    GOV_FEEDS: ClassVar[list] = [
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.atom",
        "https://www.fema.gov/feeds/fema_press_releases.rss",
        "https://alerts.weather.gov/cap/us.php?x=1",
    ]

    def _run(self, query: str, location: Optional[str] = None) -> list[dict]:
        import asyncio
        return asyncio.get_event_loop().run_until_complete(self._arun(query, location))

    async def _arun(self, query: str, location: Optional[str] = None) -> list[dict]:
        docs = []
        query_terms = set(query.lower().split())
        loc_terms = set(location.lower().split()) if location else set()

        for feed_url in self.GOV_FEEDS:
            try:
                feed = feedparser.parse(feed_url)
                for entry in feed.entries[:20]:
                    text = (
                        getattr(entry, "summary", "")
                        or getattr(entry, "description", "")
                        or ""
                    )
                    if not text:
                        continue
                    entry_lower = text.lower()
                    # Filter by query relevance; if location given, also filter by it
                    if not (query_terms & set(entry_lower.split())):
                        continue
                    if loc_terms and not (loc_terms & set(entry_lower.split())):
                        continue
                    docs.append({
                        "content": text[:800],
                        "title": entry.get("title", ""),
                        "source_type": "government_alert",
                        "url": entry.get("link", ""),
                        "published_at": entry.get("published", _now()),
                        "location": location or "",
                        "agency": feed_url.split("/")[2],
                        "priority": "high",
                    })
            except Exception as exc:
                logger.warning(f"Gov feed error ({feed_url}): {exc}")

        logger.info(f"[GovAlertTool] '{query}' loc='{location}' → {len(docs)} alerts")
        return docs[:10]


# ---------------------------------------------------------------------------
# Tool 3: Weather Report
# ---------------------------------------------------------------------------

class WeatherToolInput(BaseModel):
    location: str = Field(
        description="City name or 'lat,lon' coordinates to get weather for"
    )
    include_alerts: bool = Field(
        default=True,
        description="Whether to include severe weather alerts"
    )


class WeatherReportTool(BaseTool):
    """
    Gets live weather conditions and severe weather alerts for a location
    via WeatherAPI.com. Accepts any city name, region, or lat/lon string —
    WeatherAPI resolves the location natively, no coordinate lookup needed.
    Use when the query mentions a specific location and weather/climate
    conditions, flood risk, storm warnings, or temperature extremes.
    """
    name: str = "get_weather_report"
    description: str = (
        "Get live weather conditions and severe weather alerts for a specific city "
        "using WeatherAPI.com. Use when the query mentions weather, storms, flooding "
        "risk, heatwaves, or cyclones in a specific location. "
        "Input: city name (e.g. 'Mumbai') or 'lat,lon'. "
        "Returns current conditions + any active government-issued alerts."
    )
    args_schema: Type[BaseModel] = WeatherToolInput

    WEATHERAPI_BASE: ClassVar[str] = "https://api.weatherapi.com/v1"

    def _run(self, location: str, include_alerts: bool = True) -> list[dict]:
        import asyncio
        return asyncio.get_event_loop().run_until_complete(
            self._arun(location, include_alerts)
        )

    async def _arun(self, location: str, include_alerts: bool = True) -> list[dict]:
        api_key = os.environ.get("WEATHERAPI_KEY")
        if not api_key:
            return [{
                "content": "Weather data unavailable (WEATHERAPI_KEY not set).",
                "source_type": "weather_report",
                "title": f"Weather – {location}",
                "url": "",
                "published_at": _now(),
                "location": location,
            }]

        docs = []
        try:
            async with httpx.AsyncClient(timeout=12) as client:
                resp = await client.get(
                    f"{self.WEATHERAPI_BASE}/forecast.json",
                    params={
                        "key": api_key,
                        "q": location,          # city name or "lat,lon" — WeatherAPI resolves it
                        "days": 1,              # current day only — we want live conditions
                        "alerts": "yes",        # include government-issued weather alerts
                        "aqi": "no",
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            # --- Current conditions ---
            loc_info  = data.get("location", {})
            current   = data.get("current", {})
            condition = current.get("condition", {}).get("text", "unknown")
            city_name = loc_info.get("name", location)
            region    = loc_info.get("region", "")
            country   = loc_info.get("country", "")
            full_loc  = f"{city_name}, {region}, {country}".strip(", ")

            temp_c      = current.get("temp_c", "N/A")
            feels_c     = current.get("feelslike_c", "N/A")
            humidity    = current.get("humidity", "N/A")
            wind_kph    = current.get("wind_kph", "N/A")
            wind_dir    = current.get("wind_dir", "")
            gust_kph    = current.get("gust_kph", "N/A")
            vis_km      = current.get("vis_km", "N/A")
            uv          = current.get("uv", "N/A")
            precip_mm   = current.get("precip_mm", "N/A")
            cloud       = current.get("cloud", "N/A")
            is_day      = current.get("is_day", 1)
            last_updated = current.get("last_updated", _now())

            summary = (
                f"Current weather in {full_loc} (as of {last_updated}): {condition}. "
                f"Temperature: {temp_c}°C (feels like {feels_c}°C). "
                f"Humidity: {humidity}%. "
                f"Wind: {wind_kph} kph {wind_dir}, gusts up to {gust_kph} kph. "
                f"Precipitation: {precip_mm} mm. "
                f"Visibility: {vis_km} km. "
                f"Cloud cover: {cloud}%. "
                f"UV index: {uv}. "
                f"{'Daytime' if is_day else 'Nighttime'}."
            )
            docs.append({
                "content": summary,
                "source_type": "weather_report",
                "title": f"Weather – {full_loc}",
                "url": f"https://www.weatherapi.com/",
                "published_at": last_updated,
                "location": full_loc,
            })

            # --- Active weather alerts ---
            if include_alerts:
                alerts_data = data.get("alerts", {}).get("alert", [])
                for alert in alerts_data:
                    headline  = alert.get("headline", "")
                    event     = alert.get("event", "Weather Alert")
                    severity  = alert.get("severity", "")
                    urgency   = alert.get("urgency", "")
                    areas     = alert.get("areas", "")
                    effective = alert.get("effective", "")
                    expires   = alert.get("expires", "")
                    desc      = alert.get("desc", "")[:400]
                    instruction = alert.get("instruction", "")[:200]

                    alert_text = (
                        f"[WEATHER ALERT – {full_loc}] "
                        f"Event: {event}. Severity: {severity}. Urgency: {urgency}. "
                        f"Areas: {areas}. "
                        f"Effective: {effective} | Expires: {expires}. "
                        f"Headline: {headline}. "
                        f"Details: {desc} "
                        f"Instructions: {instruction}"
                    )
                    docs.append({
                        "content": alert_text,
                        "source_type": "weather_alert",
                        "title": event,
                        "url": "https://www.weatherapi.com/",
                        "published_at": effective or _now(),
                        "location": full_loc,
                        "priority": "high",
                    })

        except Exception as exc:
            logger.error(f"WeatherAPI error ({location}): {exc}")
            docs.append({
                "content": f"Weather fetch failed for {location}: {exc}",
                "source_type": "weather_report",
                "title": f"Weather – {location} (error)",
                "url": "", "published_at": _now(), "location": location,
            })

        logger.info(f"[WeatherTool] '{location}' → {len(docs)} records")
        return docs


# ---------------------------------------------------------------------------
# Tool 4: Instruction Manual (vector search)
# ---------------------------------------------------------------------------

class ManualToolInput(BaseModel):
    query: str = Field(
        description="Question to search in the disaster response instruction manual"
    )
    top_k: int = Field(default=5, description="Number of manual passages to return")


class InstructionManualTool(BaseTool):
    """
    Semantic search over the pre-indexed PDF instruction manual.
    Use this for: SOPs, procedural guidance, checklists, protocols,
    training material, 'what should I do' type questions.
    """
    name: str = "search_instruction_manual"
    description: str = (
        "Semantic search over the disaster response instruction manual (PDF). "
        "Use for: SOPs, step-by-step procedures, checklists, protocols, training content, "
        "'what is the procedure for X', 'what does the manual say about Y'. "
        "Returns relevant passages with page numbers."
    )
    args_schema: Type[BaseModel] = ManualToolInput

    vectorstore: Optional[object] = None  # set after init

    def _run(self, query: str, top_k: int = 5) -> list[dict]:
        if self.vectorstore is None:
            return [{
                "content": "Instruction manual not loaded (vectorstore not initialised).",
                "source_type": "instruction_manual",
                "title": "Manual",
                "url": "", "published_at": "", "location": "",
            }]
        results: list[Document] = self.vectorstore.similarity_search(query, k=top_k)
        docs = []
        for r in results:
            docs.append({
                "content": r.page_content,
                "source_type": "instruction_manual",
                "title": r.metadata.get("title", "Manual"),
                "url": r.metadata.get("file_path", ""),
                "published_at": "",
                "location": "",
                "page": r.metadata.get("page", ""),
            })
        logger.info(f"[ManualTool] '{query}' → {len(docs)} passages")
        return docs

    async def _arun(self, query: str, top_k: int = 5) -> list[dict]:
        return self._run(query, top_k)


# ---------------------------------------------------------------------------
# Tool registry factory
# ---------------------------------------------------------------------------

def build_tools(manual_vectorstore=None) -> list[BaseTool]:
    manual_tool = InstructionManualTool()
    manual_tool.vectorstore = manual_vectorstore
    return [
        LiveNewsTool(),
        GovernmentAlertTool(),
        WeatherReportTool(),
        manual_tool,
    ]