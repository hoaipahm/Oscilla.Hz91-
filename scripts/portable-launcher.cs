using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Music Green")]
[assembly: AssemblyDescription("Music Green — Offline CRT Music Player (Portable Single-File Executable)")]
[assembly: AssemblyProduct("Music Green")]
[assembly: AssemblyCopyright("Music Green — personal offline player")]
[assembly: AssemblyVersion("1.0.2.0")]
[assembly: AssemblyFileVersion("1.0.2.0")]

namespace MusicGreenPortable
{
    internal sealed class SliceStream : Stream
    {
        private readonly Stream _inner;
        private readonly long _offset;
        private readonly long _length;
        private long _position;

        public SliceStream(Stream inner, long offset, long length)
        {
            _inner = inner;
            _offset = offset;
            _length = length;
            _position = 0;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return _length; } }

        public override long Position
        {
            get { return _position; }
            set { Seek(value, SeekOrigin.Begin); }
        }

        public override void Flush() { }

        public override int Read(byte[] buffer, int offset, int count)
        {
            long remaining = _length - _position;
            if (remaining <= 0) return 0;
            if (count > remaining) count = (int)remaining;
            _inner.Position = _offset + _position;
            int read = _inner.Read(buffer, offset, count);
            _position += read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long target;
            switch (origin)
            {
                case SeekOrigin.Begin: target = offset; break;
                case SeekOrigin.Current: target = _position + offset; break;
                case SeekOrigin.End: target = _length + offset; break;
                default: throw new ArgumentOutOfRangeException("origin");
            }
            if (target < 0) target = 0;
            if (target > _length) target = _length;
            _position = target;
            return _position;
        }

        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }

    internal static class Program
    {
        private const string Magic = "MGREEN01";

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                string selfPath = Process.GetCurrentProcess().MainModule.FileName;
                long zipOffset;
                long zipLength;
                string buildId;

                using (FileStream fs = new FileStream(selfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (fs.Length < 32)
                        throw new InvalidDataException("Tệp thực thi không chứa dữ liệu đóng gói hợp lệ.");

                    fs.Position = fs.Length - 32;
                    byte[] trailer = new byte[32];
                    int read = 0;
                    while (read < 32)
                    {
                        int n = fs.Read(trailer, read, 32 - read);
                        if (n <= 0) break;
                        read += n;
                    }

                    string magic = Encoding.ASCII.GetString(trailer, 24, 8);
                    if (magic != Magic)
                        throw new InvalidDataException("Không tìm thấy chữ ký gói ứng dụng Music Green (MGREEN01).");

                    zipOffset = BitConverter.ToInt64(trailer, 0);
                    zipLength = BitConverter.ToInt64(trailer, 8);
                    ulong hash = BitConverter.ToUInt64(trailer, 16);
                    buildId = hash.ToString("x16");

                    if (zipOffset <= 0 || zipLength <= 0 || zipOffset + zipLength > fs.Length - 32)
                        throw new InvalidDataException("Dữ liệu gói ứng dụng bị hỏng hoặc không đầy đủ.");
                }

                string baseDataDir = Environment.GetEnvironmentVariable("MUSIC_GREEN_RUNTIME_DIR");
                if (string.IsNullOrEmpty(baseDataDir))
                    baseDataDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrEmpty(baseDataDir))
                    baseDataDir = Environment.GetEnvironmentVariable("LOCALAPPDATA");
                if (string.IsNullOrEmpty(baseDataDir))
                    baseDataDir = Path.GetTempPath();

                string runtimeRoot = Path.Combine(
                    baseDataDir,
                    "Music Green",
                    "runtime");
                string targetDir = Path.Combine(runtimeRoot, buildId);
                string exePath = Path.Combine(targetDir, "Music Green.exe");
                string readyFile = Path.Combine(targetDir, ".ready");

                if (!File.Exists(readyFile) || !File.Exists(exePath))
                {
                    ExtractWithSplash(selfPath, zipOffset, zipLength, runtimeRoot, targetDir, readyFile);
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = exePath;
                psi.WorkingDirectory = targetDir;
                psi.Arguments = JoinArguments(args);
                psi.UseShellExecute = false;
                if (psi.EnvironmentVariables.ContainsKey("ELECTRON_RUN_AS_NODE"))
                {
                    psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                }

                Process.Start(psi);
                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Không thể khởi động Music Green:\n" + ex.Message,
                    "Music Green",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }
        }

        private static void ExtractWithSplash(string selfPath, long zipOffset, long zipLength, string runtimeRoot, string targetDir, string readyFile)
        {
            Exception workerError = null;

            Form splash = new Form();
            splash.Text = "Music Green";
            splash.FormBorderStyle = FormBorderStyle.FixedDialog;
            splash.ControlBox = false;
            splash.StartPosition = FormStartPosition.CenterScreen;
            splash.ClientSize = new Size(420, 120);
            splash.BackColor = Color.FromArgb(3, 11, 8);
            splash.ForeColor = Color.FromArgb(94, 255, 157);
            splash.TopMost = true;

            Label title = new Label();
            title.Text = "MUSIC GREEN // KHỞI TẠO ỨNG DỤNG LẦN ĐẦU";
            title.Font = new Font("Consolas", 10.5f, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(94, 255, 157);
            title.Location = new Point(20, 22);
            title.Size = new Size(380, 24);
            splash.Controls.Add(title);

            Label status = new Label();
            status.Text = "Đang giải nén bộ chạy độc lập (0%)...";
            status.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            status.ForeColor = Color.FromArgb(165, 224, 188);
            status.Location = new Point(20, 50);
            status.Size = new Size(380, 20);
            splash.Controls.Add(status);

            ProgressBar bar = new ProgressBar();
            bar.Location = new Point(20, 76);
            bar.Size = new Size(380, 18);
            bar.Minimum = 0;
            bar.Maximum = 100;
            bar.Value = 0;
            splash.Controls.Add(bar);

            splash.Shown += delegate
            {
                Thread worker = new Thread(delegate()
                {
                    try
                    {
                        Directory.CreateDirectory(runtimeRoot);
                        string stagingDir = targetDir + ".tmp-" + Process.GetCurrentProcess().Id;
                        if (Directory.Exists(stagingDir))
                        {
                            try { Directory.Delete(stagingDir, true); } catch { }
                        }
                        Directory.CreateDirectory(stagingDir);

                        using (FileStream fs = new FileStream(selfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                        using (SliceStream slice = new SliceStream(fs, zipOffset, zipLength))
                        using (ZipArchive archive = new ZipArchive(slice, ZipArchiveMode.Read, false))
                        {
                            int total = archive.Entries.Count;
                            int index = 0;
                            foreach (ZipArchiveEntry entry in archive.Entries)
                            {
                                index++;
                                string relPath = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                                string destPath = Path.Combine(stagingDir, relPath);

                                if (string.IsNullOrEmpty(entry.Name))
                                {
                                    Directory.CreateDirectory(destPath);
                                }
                                else
                                {
                                    string parent = Path.GetDirectoryName(destPath);
                                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                                    entry.ExtractToFile(destPath, true);
                                }

                                if (total > 0 && (index % 5 == 0 || index == total))
                                {
                                    int pct = (int)((index * 100L) / total);
                                    try
                                    {
                                        splash.BeginInvoke((MethodInvoker)delegate
                                        {
                                            bar.Value = Math.Min(100, Math.Max(0, pct));
                                            status.Text = "Đang giải nén bộ chạy độc lập (" + pct + "%)...";
                                        });
                                    }
                                    catch { }
                                }
                            }
                        }

                        File.WriteAllText(Path.Combine(stagingDir, ".ready"), DateTime.UtcNow.ToString("O"), Encoding.UTF8);

                        if (Directory.Exists(targetDir))
                        {
                            try { Directory.Delete(targetDir, true); } catch { }
                        }

                        if (!Directory.Exists(targetDir))
                        {
                            Directory.Move(stagingDir, targetDir);
                        }
                        else
                        {
                            try { Directory.Delete(stagingDir, true); } catch { }
                        }

                        // Clean up older cached runtimes quietly.
                        try
                        {
                            foreach (string dir in Directory.GetDirectories(runtimeRoot))
                            {
                                if (!string.Equals(Path.GetFullPath(dir), Path.GetFullPath(targetDir), StringComparison.OrdinalIgnoreCase))
                                {
                                    try { Directory.Delete(dir, true); } catch { }
                                }
                            }
                        }
                        catch { }
                    }
                    catch (Exception ex)
                    {
                        workerError = ex;
                    }
                    finally
                    {
                        try
                        {
                            splash.BeginInvoke((MethodInvoker)delegate { splash.Close(); });
                        }
                        catch { }
                    }
                });
                worker.IsBackground = true;
                worker.Start();
            };

            Application.Run(splash);

            if (workerError != null)
            {
                throw workerError;
            }
        }

        private static string JoinArguments(string[] args)
        {
            if (args == null || args.Length == 0) return "";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < args.Length; i++)
            {
                if (i > 0) sb.Append(' ');
                string arg = args[i] ?? "";
                if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0)
                {
                    sb.Append(arg);
                }
                else
                {
                    sb.Append('"').Append(arg.Replace("\"", "\\\"")).Append('"');
                }
            }
            return sb.ToString();
        }
    }
}
