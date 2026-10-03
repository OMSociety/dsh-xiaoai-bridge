"""配置模块的加载必须是"全有或全无"（R6-5 附带项）。

热重载失败的路径上有一个隐蔽的坑：`module_from_spec` 造出来的模块对象如果在
`exec_module` **之前**就被塞进 `sys.modules["config"]`，那么 exec 中途抛异常时
这个半成品会留在缓存里 —— 别处 `import config` 拿到的是缺了一半属性的模块，
比拿到旧配置更糟。加载失败时正确的状态是：缓存里还是上一次那个能干活的模块
（或者干脆没有），而异常照旧往上抛，让调用方（app.py 的文件监听）打一条
WARNING 并等下一次 mtime 变化再试。

这里全程用临时文件，不读仓库里真正的 `config.py`。
"""

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class ConfigLoaderTest(unittest.TestCase):
    def setUp(self):
        self.loader = importlib.import_module("core.utils.config_loader")
        self.env_var = self.loader.CONFIG_ENV_VAR
        self._saved_env = os.environ.get(self.env_var)
        self._saved_module = sys.modules.get("config")
        self._had_module = "config" in sys.modules
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self._restore)

    def _restore(self):
        if self._saved_env is None:
            os.environ.pop(self.env_var, None)
        else:
            os.environ[self.env_var] = self._saved_env
        if self._had_module:
            sys.modules["config"] = self._saved_module
        else:
            sys.modules.pop("config", None)

    def _write(self, name: str, body: str) -> Path:
        path = Path(self.tmp.name) / name
        path.write_text(body, encoding="utf-8")
        return path

    def test_successful_load_registers_the_module(self):
        good = self._write("good.py", "APP_CONFIG = {'a': 1}\n")
        os.environ[self.env_var] = str(good)

        loaded = self.loader.load_config_module(force_reload=True)

        self.assertEqual({"a": 1}, loaded.APP_CONFIG)
        # 临时目录在 Windows 上可能给的是 8.3 短名，比路径字符串容易误判
        self.assertTrue(os.path.samefile(loaded.__file__, good))
        self.assertIs(loaded, sys.modules["config"])

    def test_failed_reload_keeps_the_previous_module(self):
        good = self._write("good.py", "APP_CONFIG = {'a': 1}\n")
        os.environ[self.env_var] = str(good)
        loaded = self.loader.load_config_module(force_reload=True)

        # 半路炸掉的新版本：已经定义了一个不同的 APP_CONFIG，然后抛异常
        broken = self._write(
            "broken.py", "APP_CONFIG = {'a': 2}\nraise RuntimeError('配置炸了')\n"
        )
        os.environ[self.env_var] = str(broken)

        with self.assertRaises(RuntimeError):
            self.loader.load_config_module(force_reload=True)

        # 缓存里还是旧模块，没被半成品顶掉
        self.assertIs(loaded, sys.modules["config"])
        self.assertEqual({"a": 1}, sys.modules["config"].APP_CONFIG)
        self.assertTrue(os.path.samefile(sys.modules["config"].__file__, good))

    def test_failed_first_load_leaves_no_half_module_behind(self):
        sys.modules.pop("config", None)
        broken = self._write(
            "broken.py", "APP_CONFIG = {'a': 2}\nraise RuntimeError('配置炸了')\n"
        )
        os.environ[self.env_var] = str(broken)

        with self.assertRaises(RuntimeError):
            self.loader.load_config_module(force_reload=True)

        # 第一次就失败：宁可不留，也不能留一个属性缺了一半的模块
        self.assertNotIn("config", sys.modules)

    def test_missing_file_is_reported_not_silently_ignored(self):
        missing = Path(self.tmp.name) / "nope.py"
        os.environ[self.env_var] = str(missing)

        with self.assertRaises(FileNotFoundError):
            self.loader.load_config_module(force_reload=True)


if __name__ == "__main__":
    unittest.main()
