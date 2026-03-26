import os

def list_files(base_path, exclude_dirs=None):
    if exclude_dirs is None:
        exclude_dirs = []

    # Convert to set for faster lookup
    exclude_dirs = set(exclude_dirs)

    for root, dirs, files in os.walk(base_path):
        # Modify dirs in-place to prevent walking into excluded folders
        dirs[:] = [d for d in dirs if d not in exclude_dirs]

        print(f"\nDirectory: {root}")

        for d in dirs:
            print(f"  [D] {d}")

        for f in files:
            print(f"  [F] {f}")


if __name__ == "__main__":
    base_directory = "."  # change this to your target directory

    exclude = [
        "node_modules",
        ".git",
        "__pycache__",
        "venv",
        "graph_venv",
        "chroma_manual_db",
    ]

    list_files(base_directory, exclude)