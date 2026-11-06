"""The CI doc names every workflow, so a new workflow cannot merge undocumented."""

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class CiDocs(unittest.TestCase):
    def test_every_workflow_is_named(self):
        documented = (ROOT / "docs" / "ci.md").read_text()
        missing = [
            path.name
            for path in sorted((ROOT / ".github" / "workflows").glob("*.yml"))
            if path.name not in documented
        ]
        self.assertEqual(missing, [])

    def test_handbook_points_at_the_map(self):
        text = (ROOT / "docs" / "handbook.md").read_text()
        for name in ("AGENTS.md", "docs/architecture.md", "docs/ci.md", "docs/legacy.md"):
            self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
