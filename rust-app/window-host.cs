using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Music Green Window Host")]
[assembly: AssemblyProduct("Music Green")]
[assembly: AssemblyVersion("1.0.2.0")]
[assembly: AssemblyFileVersion("1.0.2.0")]

namespace MusicGreenHost
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 2) return 1;
            string url = args[0];
            string userDataDir = args[1];
            string iconPath = args.Length > 2 ? args[2] : null;

            bool createdNew = true;
            Mutex instanceMutex = null;
            try
            {
                instanceMutex = new Mutex(true, "Local\\MusicGreenSingleInstanceMutex", out createdNew);
            }
            catch { }
            if (!createdNew)
            {
                try
                {
                    EventWaitHandle existingEvent = EventWaitHandle.OpenExisting("Local\\MusicGreenActivateEvent");
                    existingEvent.Set();
                }
                catch { }
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Form form = new Form();
            form.Text = "Music Green";
            form.ClientSize = new Size(1464, 921);
            form.MinimumSize = new Size(900, 680);
            form.StartPosition = FormStartPosition.CenterScreen;
            form.BackColor = Color.FromArgb(3, 11, 8);
            if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath))
            {
                try { form.Icon = new Icon(iconPath); } catch { }
            }

            WebView2 webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.FromArgb(3, 11, 8);
            form.Controls.Add(webView);

            EventWaitHandle activateEvent = null;
            try
            {
                activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\MusicGreenActivateEvent");
                Thread listener = new Thread(delegate()
                {
                    while (true)
                    {
                        try
                        {
                            activateEvent.WaitOne();
                            form.BeginInvoke((MethodInvoker)delegate
                            {
                                if (form.WindowState == FormWindowState.Minimized)
                                    form.WindowState = FormWindowState.Normal;
                                form.Show();
                                form.Activate();
                            });
                        }
                        catch { break; }
                    }
                });
                listener.IsBackground = true;
                listener.Start();
            }
            catch { }

            bool closing = false;
            form.FormClosing += async delegate(object sender, FormClosingEventArgs e)
            {
                if (closing) return;
                closing = true;
                e.Cancel = true;
                try
                {
                    if (webView.CoreWebView2 != null)
                    {
                        Task flushTask = webView.ExecuteScriptAsync("window.MusicGreenFlush ? window.MusicGreenFlush() : null");
                        await Task.WhenAny(flushTask, Task.Delay(1200));
                    }
                }
                catch { }
                form.Dispose();
                Application.ExitThread();
            };

            form.Load += async delegate
            {
                try
                {
                    string wv2Data = Path.Combine(userDataDir, "webview2-cache");
                    Directory.CreateDirectory(wv2Data);
                    CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, wv2Data);
                    await webView.EnsureCoreWebView2Async(env);
                    webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                    webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    webView.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs ev)
                    {
                        ev.Handled = true;
                    };
                    webView.CoreWebView2.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs ev)
                    {
                        if (!ev.Uri.StartsWith(url, StringComparison.OrdinalIgnoreCase))
                        {
                            ev.Cancel = true;
                        }
                    };
                    webView.CoreWebView2.Navigate(url);
                }
                catch
                {
                    Environment.ExitCode = 2;
                    form.Dispose();
                    Application.ExitThread();
                }
            };

            Application.Run(form);
            return 0;
        }
    }
}
