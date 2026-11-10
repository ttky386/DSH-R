using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

// 0.1.18（以及更早的 Inno 安装版）自更新的兼容桥：
// 旧启动器用 `/silent /log=<file>` 拉起安装包，等日志文件出现就认为安装已开始并退出。
// 新安装包是 electron-builder 的 NSIS，不认这两个参数；这个桥先写日志，再把内嵌的
// 新版 NSIS 安装包用 `/S` 静默跑完，最后拉起新版。
internal static class LegacyUpdaterBridge
{
    [STAThread]
    private static int Main(string[] args)
    {
        string log = null;
        foreach (string arg in args)
        {
            if (arg.StartsWith("/log=", StringComparison.OrdinalIgnoreCase))
                log = arg.Substring(5).Trim('"');
        }
        if (!string.IsNullOrEmpty(log))
        {
            try
            {
                File.WriteAllText(log, "legacy updater bridge " + DateTime.UtcNow.ToString("o") + Environment.NewLine);
            }
            catch
            {
                // 日志写不了也不能挡安装；旧启动器最多以为安装没开始，用户仍能手动装
            }
        }

        Assembly assembly = Assembly.GetExecutingAssembly();
        string[] resources = assembly.GetManifestResourceNames();
        if (resources.Length == 0) return 2;

        string temp = Path.Combine(Path.GetTempPath(), "DSH-Setup-" + Guid.NewGuid().ToString("N") + ".exe");
        try
        {
            using (Stream input = assembly.GetManifestResourceStream(resources[0]))
            using (FileStream output = File.Create(temp))
            {
                input.CopyTo(output);
            }
            using (Process installer = Process.Start(new ProcessStartInfo(temp, "/S") { UseShellExecute = false }))
            {
                installer.WaitForExit();
            }
        }
        finally
        {
            try { File.Delete(temp); } catch { }
        }

        string app = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "DSH", "DSH.exe");
        if (File.Exists(app))
        {
            try { Process.Start(new ProcessStartInfo(app) { UseShellExecute = true }); } catch { }
        }
        return 0;
    }
}
