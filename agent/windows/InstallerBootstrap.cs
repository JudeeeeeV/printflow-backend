using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class InstallerBootstrap
{
    [STAThread]
    private static int Main()
    {
        string tempDirectory = Path.Combine(
            Path.GetTempPath(),
            "PrintFlowAgentSetup-" + Guid.NewGuid().ToString("N"));

        try
        {
            Directory.CreateDirectory(tempDirectory);
            string archivePath = Path.Combine(tempDirectory, "agent-package.zip");
            string scriptPath = Path.Combine(tempDirectory, "installer-install.ps1");
            ExtractResource("PrintFlow.AgentPackage", archivePath);
            ExtractResource("PrintFlow.InstallScript", scriptPath);

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = "powershell.exe";
            startInfo.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";
            startInfo.WorkingDirectory = tempDirectory;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            startInfo.RedirectStandardError = true;

            using (Process process = Process.Start(startInfo))
            {
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    throw new InvalidOperationException(
                        String.IsNullOrWhiteSpace(error)
                            ? "The installer could not complete."
                            : error.Trim());
                }
            }
            return 0;
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                exception.Message,
                "PrintFlow Printer Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempDirectory))
                {
                    Directory.Delete(tempDirectory, true);
                }
            }
            catch
            {
                // Windows will eventually clean its temporary directory.
            }
        }
    }

    private static void ExtractResource(string resourceName, string targetPath)
    {
        Assembly assembly = Assembly.GetExecutingAssembly();
        using (Stream source = assembly.GetManifestResourceStream(resourceName))
        {
            if (source == null)
            {
                throw new InvalidOperationException("The installer payload is incomplete.");
            }
            using (FileStream target = File.Create(targetPath))
            {
                source.CopyTo(target);
            }
        }
    }
}
