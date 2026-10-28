"""The server replays this wheel's upload fixture; it must be what the current adapter makes."""

import unittest

from tests.upload_fixture import TARGET, render


class UploadFixtureTest(unittest.TestCase):
    def test_fixture_is_current(self) -> None:
        with open(TARGET, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), render(), "run `python -m tests.upload_fixture` in runtime/databricks")


if __name__ == "__main__":
    unittest.main()
