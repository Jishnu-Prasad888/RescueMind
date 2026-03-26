"""
hierarchical_index.py
======================
Implements Hierarchical Indices (technique #19 from the image).

Strategy:
  - Parent chunks (512 tokens) capture full semantic context
  - Child chunks (128 tokens) are embedded and retrieved for precision
  - Each child carries a `parent_id` so we can expand back to the parent
    for the final LLM context window (ParentDocumentRetriever pattern)
"""

import uuid
import logging
from langchain.schema import Document
from langchain.text_splitter import RecursiveCharacterTextSplitter

logger = logging.getLogger(__name__)


class HierarchicalIndexManager:
    """
    Splits raw documents into a two-level hierarchy:
      parent_docs – large chunks used as final LLM context
      child_docs  – small chunks embedded into the vector store

    Each child stores `parent_id` in its metadata. After retrieval, 
    the pipeline can optionally hydrate back to parent context.
    """

    def __init__(
        self,
        parent_chunk_size: int = 512,
        parent_chunk_overlap: int = 64,
        child_chunk_size: int = 128,
        child_chunk_overlap: int = 16,
    ):
        self.parent_splitter = RecursiveCharacterTextSplitter(
            chunk_size=parent_chunk_size,
            chunk_overlap=parent_chunk_overlap,
            separators=["\n\n", "\n", ". ", " ", ""],
            length_function=len,
        )
        self.child_splitter = RecursiveCharacterTextSplitter(
            chunk_size=child_chunk_size,
            chunk_overlap=child_chunk_overlap,
            separators=["\n", ". ", " ", ""],
            length_function=len,
        )

        # In-memory parent store: parent_id → Document
        self._parent_store: dict[str, Document] = {}

    def split(
        self, raw_docs: list[Document]
    ) -> tuple[list[Document], list[Document]]:
        """
        Returns (parent_docs, child_docs).
        parent_docs are stored internally and can be fetched via get_parent().
        child_docs go into the vector store.
        """
        parent_docs: list[Document] = []
        child_docs: list[Document] = []

        for doc in raw_docs:
            # Split into parents first
            parents = self.parent_splitter.split_documents([doc])
            for parent in parents:
                parent_id = str(uuid.uuid4())
                parent.metadata["parent_id"] = parent_id
                parent.metadata["chunk_level"] = "parent"
                self._parent_store[parent_id] = parent
                parent_docs.append(parent)

                # Split each parent into children
                children = self.child_splitter.split_documents([parent])
                for i, child in enumerate(children):
                    child.metadata["parent_id"] = parent_id
                    child.metadata["chunk_level"] = "child"
                    child.metadata["child_index"] = i
                    child_docs.append(child)

        logger.info(
            f"HierarchicalIndex: {len(parent_docs)} parents → "
            f"{len(child_docs)} children"
        )
        return parent_docs, child_docs

    def get_parent(self, parent_id: str) -> Document | None:
        """Hydrate a child back to its parent document."""
        return self._parent_store.get(parent_id)

    def hydrate_to_parents(
        self, child_docs: list[Document]
    ) -> list[Document]:
        """
        Given a list of retrieved child docs, return their parent docs.
        Deduplicates: multiple children from the same parent → one parent.
        """
        seen: set[str] = set()
        parents: list[Document] = []
        for child in child_docs:
            pid = child.metadata.get("parent_id")
            if pid and pid not in seen:
                parent = self.get_parent(pid)
                if parent:
                    parents.append(parent)
                    seen.add(pid)
                else:
                    # Parent not found – fall back to child
                    parents.append(child)
        return parents