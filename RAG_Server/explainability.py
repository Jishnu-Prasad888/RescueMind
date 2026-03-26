"""
explainability.py
==================
Implements Explainable Retrieval (technique #28).

For every document in the final context window, records:
  - relevance_score   (cross-encoder score)
  - retrieval_method  (which retriever surfaced it)
  - source_type       (news / gov_alert / weather / manual)
  - chunk_level       (parent / child)
  - key_phrases       (top overlapping n-grams with query)
"""

import logging
from langchain_core.documents import Document

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lightweight n-gram extractor (no heavy NLP dep required)
# ---------------------------------------------------------------------------

def _extract_ngrams(text: str, n: int = 2) -> set[str]:
    words = [w.strip(".,!?;:'\"()").lower() for w in text.split() if len(w) > 3]
    return {" ".join(words[i:i+n]) for i in range(len(words) - n + 1)}


def _key_phrases(query: str, doc_text: str, top_k: int = 5) -> list[str]:
    query_ngrams = _extract_ngrams(query, 1) | _extract_ngrams(query, 2)
    doc_ngrams = _extract_ngrams(doc_text, 1) | _extract_ngrams(doc_text, 2)
    overlap = query_ngrams & doc_ngrams
    # Sort by length (longer = more specific)
    return sorted(overlap, key=len, reverse=True)[:top_k]


# ---------------------------------------------------------------------------
# Tracer
# ---------------------------------------------------------------------------

class ExplainabilityTracer:
    """
    Scores and annotates retrieved documents for transparency.
    Uses the cross-encoder for relevance if available, otherwise
    falls back to a token-overlap proxy score.
    """

    def __init__(self, cross_encoder_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"):
        self._ce = None
        try:
            from sentence_transformers import CrossEncoder
            self._ce = CrossEncoder(cross_encoder_model)
            logger.info("ExplainabilityTracer: CrossEncoder loaded")
        except ImportError:
            logger.warning(
                "sentence-transformers not found; "
                "using proxy relevance scores"
            )

    def trace(self, query: str, documents: list[Document]) -> list[dict]:
        """
        Returns a list of trace records, one per document.
        Each record contains all info needed to explain why a doc was chosen.
        """
        # Batch cross-encoder scoring
        scores: list[float] = []
        if self._ce and documents:
            pairs = [(query, doc.page_content) for doc in documents]
            raw_scores = self._ce.predict(pairs)
            # Sigmoid to [0, 1]
            import math
            scores = [1 / (1 + math.exp(-s)) for s in raw_scores]
        else:
            scores = [self._proxy_score(query, doc) for doc in documents]

        trace_records = []
        for doc, score in zip(documents, scores):
            phrases = _key_phrases(query, doc.page_content)
            record = {
                "title": doc.metadata.get("title", ""),
                "source_type": doc.metadata.get("source_type", "unknown"),
                "chunk_level": doc.metadata.get("chunk_level", "child"),
                "url": doc.metadata.get("url", ""),
                "published_at": doc.metadata.get("published_at", ""),
                "relevance_score": round(score, 4),
                "key_phrases": phrases,
                "snippet": doc.page_content[:200].strip(),
                "retrieval_explanation": self._explain(
                    score, doc.metadata.get("source_type", ""), phrases
                ),
            }
            trace_records.append(record)

        # Sort descending by relevance
        trace_records.sort(key=lambda x: x["relevance_score"], reverse=True)
        return trace_records

    # ------------------------------------------------------------------
    # Proxy score (token overlap, used if CrossEncoder unavailable)
    # ------------------------------------------------------------------

    @staticmethod
    def _proxy_score(query: str, doc: Document) -> float:
        q_terms = set(query.lower().split())
        d_terms = set(doc.page_content.lower().split())
        if not q_terms:
            return 0.0
        overlap = len(q_terms & d_terms)
        return min(overlap / len(q_terms), 1.0)

    # ------------------------------------------------------------------
    # Human-readable explanation
    # ------------------------------------------------------------------

    @staticmethod
    def _explain(score: float, source_type: str, phrases: list[str]) -> str:
        level = (
            "highly relevant" if score > 0.8 else
            "moderately relevant" if score > 0.5 else
            "marginally relevant"
        )
        phrase_str = ", ".join(f'"{p}"' for p in phrases[:3]) or "general overlap"
        return (
            f"Scored as {level} (score={score:.2f}). "
            f"Source: {source_type}. "
            f"Matched phrases: {phrase_str}."
        )