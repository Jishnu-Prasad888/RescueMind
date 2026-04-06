"""
ml_provider.py
==============
Loads and serves the ML hazard matrix to the routing engine.
The hazard matrix is a 2D numpy array produced by the disaster CNN classifier.
Each cell represents a spatial hazard multiplier — higher values mean more danger.

Supports:
  - Static loading from a CSV file (blurred_matrix.csv)
  - Dynamic updates via gRPC (for live ML model inference pushes)
  - Auto-deriving geographic bounds from the graph's bounding box
"""

import os
import logging
import numpy as np

logger = logging.getLogger(__name__)


class MLProvider:
    """
    Manages the ML hazard matrix and its mapping to geographic coordinates.
    """

    def __init__(self):
        self.matrix = None
        self.top_left_lat = 0.0
        self.top_left_lon = 0.0
        self.lat_step = 0.0
        self.lon_step = 0.0

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    def load_from_csv(self, path: str) -> bool:
        """Load a hazard matrix from a CSV file (numpy savetxt format)."""
        if not os.path.exists(path):
            logger.warning(f"ML matrix CSV not found: {path}")
            return False

        try:
            self.matrix = np.loadtxt(path, delimiter=",")
            logger.info(
                f"ML hazard matrix loaded: shape={self.matrix.shape} "
                f"min={self.matrix.min():.4f} max={self.matrix.max():.4f}"
            )
            return True
        except Exception as exc:
            logger.error(f"Failed to load ML matrix from {path}: {exc}")
            return False

    # ------------------------------------------------------------------
    # Dynamic update
    # ------------------------------------------------------------------

    def update_matrix(self, rows: list[list[float]]) -> None:
        """Replace the current matrix with a new one (from gRPC push)."""
        self.matrix = np.array(rows, dtype=np.float64)
        logger.info(
            f"ML hazard matrix updated dynamically: shape={self.matrix.shape} "
            f"min={self.matrix.min():.4f} max={self.matrix.max():.4f}"
        )

    # ------------------------------------------------------------------
    # Bounds computation
    # ------------------------------------------------------------------

    def compute_bounds(self, G) -> None:
        """
        Derive the geographic bounding box from the graph's node positions.
        Nodes store pos as (lon, lat).
        The ML matrix is a grid overlaid on this bounding box.
        """
        lats = []
        lons = []
        for node in G.nodes:
            pos = G.nodes[node].get("pos")
            if pos:
                lon, lat = pos
                lats.append(lat)
                lons.append(lon)

        if not lats:
            logger.warning("No node positions found — cannot compute bounds")
            return

        min_lat, max_lat = min(lats), max(lats)
        min_lon, max_lon = min(lons), max(lons)

        rows, cols = self.matrix.shape

        # Top-left corner of the grid (max lat, min lon) — north-west
        self.top_left_lat = max_lat
        self.top_left_lon = min_lon

        # Step size per grid cell (lat decreases going down rows)
        self.lat_step = (max_lat - min_lat) / rows if rows > 0 else 0
        self.lon_step = (max_lon - min_lon) / cols if cols > 0 else 0

        logger.info(
            f"ML grid bounds computed: "
            f"top_left=({self.top_left_lat:.6f}, {self.top_left_lon:.6f}) "
            f"lat_step={self.lat_step:.8f} lon_step={self.lon_step:.8f}"
        )

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    def get_matrix(self):
        """Return the current hazard matrix as a 2D list (for graph_updater)."""
        if self.matrix is None:
            return None
        return self.matrix.tolist()

    def is_loaded(self) -> bool:
        return self.matrix is not None
