// Visible-presence overlay shown while an agent drives the mouse and keyboard.
//
// Three surfaces, all click-through except the status panel's Release button:
//   * a glow along each edge of the primary screen,
//   * the agent's own pointer, drawn apart from the real one, gliding to each target,
//   * an always-on-top panel naming the agent and its current action.
//
// The agent's pointer travels visibly; the real pointer only jumps to the target for the
// instant of a click and then goes back to where the person left it. A drag holds the real
// button down, so for a drag the real pointer travels along with the drawn one.
//
// State comes from a JSON file the agent writes; see agent_screen_control.ps1. Pointer
// commands are acknowledged in a second file so the script can wait for them to finish.
// Compiled at run time by that script with Add-Type, so this must stay C# 5 and ASCII.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace ArcRho.ScreenControl
{
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct SIZE { public int cx; public int cy; }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        public struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER
        {
            public int biSize;
            public int biWidth;
            public int biHeight;
            public short biPlanes;
            public short biBitCount;
            public int biCompression;
            public int biSizeImage;
            public int biXPelsPerMeter;
            public int biYPelsPerMeter;
            public int biClrUsed;
            public int biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        // Only the mouse member is declared: it is the union's largest, so INPUT keeps the
        // 40 bytes x64 expects. Any other size makes SendInput reject every event.
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public INPUTUNION u; }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst,
            ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after,
            int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h,
            IntPtr src, int sx, int sy, int rop);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] public static extern bool GdiFlush();
        [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc,
            ref BITMAPINFOHEADER header, uint usage, out IntPtr bits, IntPtr section, uint offset);

        public const int ULW_ALPHA = 2;
        public const uint GA_ROOT = 2;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;

        /// <summary>
        /// Works in real screen pixels, the ones a screenshot shows. Per-monitor awareness is
        /// needed for that: when the session's scale changed after logon (an RDP reconnect at
        /// another size), Windows stretches a merely system-aware process, and its coordinates
        /// then run 25% or more away from the screenshot's.
        /// </summary>
        public static void UseRealPixels()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; // PER_MONITOR_AWARE_V2
            }
            catch (EntryPointNotFoundException) { }
            SetProcessDPIAware();
        }

        // WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        public const int EX_CLICK_THROUGH = 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000;
        // WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        public const int EX_PANEL = 0x00000080 | 0x08000000;
    }

    /// <summary>The real, system pointer: the one that actually clicks.</summary>
    public static class RealPointer
    {
        public static bool InputSizeIsRight
        {
            get { return Marshal.SizeOf(typeof(Native.INPUT)) == (IntPtr.Size == 8 ? 40 : 28); }
        }

        public static Native.POINT Where()
        {
            Native.POINT p;
            Native.GetCursorPos(out p);
            return p;
        }

        /// <summary>Puts the real pointer on a pixel; a drag also sends a move event so the app tracks it.</summary>
        public static bool MoveTo(int x, int y, bool announce)
        {
            Native.SetCursorPos(x, y);
            if (announce) Send(Native.MOUSEEVENTF_MOVE);
            Native.POINT p = Where();
            return Math.Abs(p.X - x) <= 1 && Math.Abs(p.Y - y) <= 1;
        }

        public static bool Button(bool right, bool down)
        {
            uint flags = right
                ? (down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP)
                : (down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP);
            return Send(flags);
        }

        private static bool Send(uint flags)
        {
            Native.INPUT[] input = new Native.INPUT[1];
            input[0].type = 0; // INPUT_MOUSE; a zero dx/dy with no ABSOLUTE flag leaves the position alone
            input[0].u.mi.dwFlags = flags;
            return Native.SendInput(1, input, Marshal.SizeOf(typeof(Native.INPUT))) == 1;
        }
    }

    /// <summary>A visible top-level window, in real screen pixels.</summary>
    public class WindowInfo
    {
        public int Order;          // 0 is frontmost
        public string Title;
        public string Process;
        public Rectangle Bounds;
        public bool Minimized;

        public override string ToString()
        {
            string where = Minimized ? "minimised"
                : string.Format(CultureInfo.InvariantCulture, "x={0} y={1} width={2} height={3}",
                    Bounds.Left, Bounds.Top, Bounds.Width, Bounds.Height);
            return string.Format(CultureInfo.InvariantCulture, "{0,2}  {1}  [{2}]  {3}",
                Order, where, Process, Title);
        }
    }

    /// <summary>How an agent sees the screen: real-pixel screenshots and the windows on it.</summary>
    public static class ScreenTools
    {
        /// <summary>Visible, titled top-level windows, front to back; match filters on title or process name.</summary>
        public static List<WindowInfo> Windows(string match)
        {
            List<WindowInfo> found = new List<WindowInfo>();
            Dictionary<uint, string> names = new Dictionary<uint, string>();
            int order = 0;
            Native.EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h)) return true;
                StringBuilder sb = new StringBuilder(256);
                Native.GetWindowText(h, sb, sb.Capacity);
                if (sb.Length == 0) return true;
                Native.RECT r;
                Native.GetWindowRect(h, out r);
                bool minimized = Native.IsIconic(h);
                if (!minimized && (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0)) return true;
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                string process;
                if (!names.TryGetValue(pid, out process))
                {
                    process = "";
                    try { process = Process.GetProcessById((int)pid).ProcessName; }
                    catch (ArgumentException) { }
                    catch (InvalidOperationException) { }
                    names[pid] = process;
                }
                WindowInfo w = new WindowInfo();
                w.Order = order++;
                w.Title = sb.ToString();
                w.Process = process;
                w.Bounds = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
                w.Minimized = minimized;
                if (string.IsNullOrEmpty(match)
                    || w.Title.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0
                    || w.Process.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0)
                    found.Add(w);
                return true;
            }, IntPtr.Zero);
            return found;
        }

        /// <summary>Saves a PNG of a screen region (the whole primary screen when width is 0).</summary>
        public static string Capture(string path, int x, int y, int width, int height, double zoom)
        {
            if (width <= 0 || height <= 0)
            {
                Rectangle s = Screen.PrimaryScreen.Bounds;
                x = s.Left; y = s.Top; width = s.Width; height = s.Height;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            using (Bitmap shot = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(shot))
                {
                    IntPtr dst = g.GetHdc();
                    IntPtr screen = Native.GetDC(IntPtr.Zero);
                    Native.BitBlt(dst, 0, 0, width, height, screen, x, y, 0x00CC0020); // SRCCOPY
                    Native.ReleaseDC(IntPtr.Zero, screen);
                    g.ReleaseHdc(dst);
                }
                if (zoom == 1.0)
                {
                    shot.Save(path, ImageFormat.Png);
                }
                else
                {
                    int zw = Math.Max(1, (int)Math.Round(width * zoom));
                    int zh = Math.Max(1, (int)Math.Round(height * zoom));
                    using (Bitmap scaled = new Bitmap(zw, zh, PixelFormat.Format32bppArgb))
                    using (Graphics g = Graphics.FromImage(scaled))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(shot, 0, 0, zw, zh);
                        scaled.Save(path, ImageFormat.Png);
                    }
                }
            }
            return string.Format(CultureInfo.InvariantCulture,
                "saved {0}  origin x={1} y={2}  size {3}x{4}  zoom {5}", path, x, y, width, height, zoom);
        }
    }

    /// <summary>A borderless, click-through, always-on-top window painted with per-pixel alpha.</summary>
    public class LayeredOverlay : Form
    {
        private IntPtr _memDc = IntPtr.Zero;
        private IntPtr _hBitmap = IntPtr.Zero;
        private IntPtr _oldBitmap = IntPtr.Zero;
        private Size _size = Size.Empty;
        private Bitmap _canvas;

        public LayeredOverlay()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Native.EX_CLICK_THROUGH;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        /// <summary>Caches still artwork as a GDI bitmap so each frame is only a blend, not a redraw.</summary>
        public void SetArtwork(Bitmap bitmap)
        {
            ReleaseArtwork();
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            _memDc = Native.CreateCompatibleDC(screenDc);
            _hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
            _oldBitmap = Native.SelectObject(_memDc, _hBitmap);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
            _size = bitmap.Size;
        }

        /// <summary>A premultiplied surface shared with GDI, for artwork redrawn every frame.</summary>
        public Bitmap UseCanvas(int width, int height)
        {
            ReleaseArtwork();
            Native.BITMAPINFOHEADER header = new Native.BITMAPINFOHEADER();
            header.biSize = Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            header.biWidth = width;
            header.biHeight = -height; // top-down, so row 0 is the top as GDI+ expects
            header.biPlanes = 1;
            header.biBitCount = 32;
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr bits;
            _hBitmap = Native.CreateDIBSection(screenDc, ref header, 0, out bits, IntPtr.Zero, 0);
            _memDc = Native.CreateCompatibleDC(screenDc);
            _oldBitmap = Native.SelectObject(_memDc, _hBitmap);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
            _size = new Size(width, height);
            _canvas = new Bitmap(width, height, width * 4, PixelFormat.Format32bppPArgb, bits);
            return _canvas;
        }

        public void Push(int left, int top, byte alpha)
        {
            if (_memDc == IntPtr.Zero) return;
            if (_canvas != null) Native.GdiFlush();
            Native.POINT dst = new Native.POINT(); dst.X = left; dst.Y = top;
            Native.POINT src = new Native.POINT(); src.X = 0; src.Y = 0;
            Native.SIZE size = new Native.SIZE(); size.cx = _size.Width; size.cy = _size.Height;
            Native.BLENDFUNCTION blend = new Native.BLENDFUNCTION();
            blend.BlendOp = 0;            // AC_SRC_OVER
            blend.SourceConstantAlpha = alpha;
            blend.AlphaFormat = 1;        // AC_SRC_ALPHA
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            Native.UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, _memDc, ref src, 0,
                ref blend, Native.ULW_ALPHA);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
        }

        private void ReleaseArtwork()
        {
            if (_canvas != null) { _canvas.Dispose(); _canvas = null; }
            if (_memDc == IntPtr.Zero) return;
            Native.SelectObject(_memDc, _oldBitmap);
            Native.DeleteObject(_hBitmap);
            Native.DeleteDC(_memDc);
            _memDc = IntPtr.Zero; _hBitmap = IntPtr.Zero; _oldBitmap = IntPtr.Zero;
        }

        protected override void Dispose(bool disposing)
        {
            ReleaseArtwork();
            base.Dispose(disposing);
        }
    }

    public static class Artwork
    {
        public enum Edge { Top, Bottom, Left, Right }

        /// <summary>A strip that is solid against the screen edge and fades to nothing inward.</summary>
        public static Bitmap EdgeGlow(int width, int height, Color color, Edge edge, int thickness)
        {
            Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, width, height),
                ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            byte[] pixels = new byte[stride * height];
            byte[] falloff = new byte[thickness];
            for (int d = 0; d < thickness; d++)
            {
                double t = 1.0 - ((double)d / thickness);
                falloff[d] = (byte)Math.Round(255.0 * Math.Pow(t, 1.9));
            }
            for (int y = 0; y < height; y++)
            {
                int row = y * stride;
                for (int x = 0; x < width; x++)
                {
                    int d;
                    if (edge == Edge.Top) d = y;
                    else if (edge == Edge.Bottom) d = height - 1 - y;
                    else if (edge == Edge.Left) d = x;
                    else d = width - 1 - x;
                    byte a = d < thickness ? falloff[d] : (byte)0;
                    int i = row + x * 4;
                    pixels[i] = color.B;
                    pixels[i + 1] = color.G;
                    pixels[i + 2] = color.R;
                    pixels[i + 3] = a;
                }
            }
            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            bmp.UnlockBits(data);
            return bmp;
        }
    }

    /// <summary>
    /// The agent's pointer: a grey arrow with a white rim and a soft shadow, over a glow in the
    /// accent colour. The tip sits at the centre of the canvas so it can lean and press in place.
    /// </summary>
    public class CursorSprite : IDisposable
    {
        public readonly int Size;
        private readonly float _s;
        private readonly PointF[] _arrow;
        private Bitmap _fog;
        private Color _fogColor = Color.Empty;

        public CursorSprite(double scale)
        {
            _s = (float)scale;
            Size = (int)Math.Round(140 * scale);
            float u = (float)(1.1 * scale);
            _arrow = new PointF[] {
                new PointF(0, 0),
                new PointF(0, 17.0f * u),
                new PointF(4.4f * u, 13.3f * u),
                new PointF(7.6f * u, 20.4f * u),
                new PointF(10.5f * u, 19.1f * u),
                new PointF(7.4f * u, 12.3f * u),
                new PointF(13.2f * u, 12.3f * u)
            };
        }

        /// <param name="angle">Clockwise lean in degrees, about the tip.</param>
        /// <param name="press">Arrow scale; below 1 while a button is going down.</param>
        /// <param name="fog">Glow strength from 0 to 1.</param>
        /// <param name="pulse">Progress of the click ripple from 0 to 1, or negative for none.</param>
        public void Render(Graphics g, double angle, double press, double fog, double pulse, Color accent)
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            float c = Size / 2f;

            EnsureFog(accent);
            using (ImageAttributes attrs = new ImageAttributes())
            {
                ColorMatrix m = new ColorMatrix();
                m.Matrix33 = (float)Math.Max(0, Math.Min(1, fog));
                attrs.SetColorMatrix(m);
                float fx = c + 5 * _s - _fog.Width / 2f, fy = c + 9 * _s - _fog.Height / 2f;
                g.DrawImage(_fog, new Rectangle((int)fx, (int)fy, _fog.Width, _fog.Height),
                    0, 0, _fog.Width, _fog.Height, GraphicsUnit.Pixel, attrs);
            }

            if (pulse >= 0)
            {
                double eased = 1.0 - Math.Pow(1.0 - pulse, 3);
                float r = (float)(4 * _s + 26 * _s * eased);
                int a = (int)Math.Round(220 * (1.0 - pulse));
                using (Pen pen = new Pen(Color.FromArgb(a, accent), (float)(2.6 * _s * (1.0 - 0.5 * pulse))))
                {
                    g.DrawEllipse(pen, c - r, c - r, r * 2, r * 2);
                }
            }

            GraphicsState saved = g.Save();
            g.TranslateTransform(c, c);
            g.RotateTransform((float)angle);
            g.ScaleTransform((float)press, (float)press);
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddPolygon(_arrow);

                GraphicsState beforeShadow = g.Save();
                g.TranslateTransform(1.2f * _s, 2.0f * _s);
                using (Pen blur = new Pen(Color.FromArgb(26, 0, 0, 0), 4.0f * _s))
                {
                    blur.LineJoin = LineJoin.Round;
                    g.DrawPath(blur, path);
                }
                using (SolidBrush shade = new SolidBrush(Color.FromArgb(60, 0, 0, 0)))
                {
                    g.FillPath(shade, path);
                }
                g.Restore(beforeShadow);

                using (SolidBrush body = new SolidBrush(Color.FromArgb(242, 78, 75, 72)))
                {
                    g.FillPath(body, path);
                }
                using (Pen rim = new Pen(Color.FromArgb(240, 255, 255, 255), 1.7f * _s))
                {
                    rim.LineJoin = LineJoin.Round;
                    g.DrawPath(rim, path);
                }
            }
            g.Restore(saved);
        }

        private void EnsureFog(Color color)
        {
            if (_fog != null && _fogColor == color) return;
            if (_fog != null) _fog.Dispose();
            _fogColor = color;
            int size = (int)Math.Round(76 * _s);
            _fog = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            BitmapData data = _fog.LockBits(new Rectangle(0, 0, size, size),
                ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            byte[] pixels = new byte[stride * size];
            double r = size / 2.0;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    double dx = x + 0.5 - r, dy = y + 0.5 - r;
                    double t = 1.0 - Math.Sqrt(dx * dx + dy * dy) / r;
                    int i = y * stride + x * 4;
                    pixels[i] = color.B;
                    pixels[i + 1] = color.G;
                    pixels[i + 2] = color.R;
                    pixels[i + 3] = t <= 0 ? (byte)0 : (byte)Math.Round(125.0 * Math.Pow(t, 1.5));
                }
            }
            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            _fog.UnlockBits(data);
        }

        public void Dispose()
        {
            if (_fog != null) _fog.Dispose();
        }
    }

    /// <summary>
    /// One journey of the agent's pointer: a gently bowed cubic curve travelled with the
    /// minimum-jerk speed profile of a human reach, taking longer for longer distances.
    /// </summary>
    public class Glide
    {
        public readonly double StartMs;
        public readonly double DurationMs;
        private readonly double _x0, _y0, _x1, _y1, _x2, _y2, _x3, _y3;

        public Glide(double x0, double y0, double x3, double y3, double scale, double startMs, Random rng)
        {
            StartMs = startMs;
            _x0 = x0; _y0 = y0; _x3 = x3; _y3 = y3;
            double dx = x3 - x0, dy = y3 - y0;
            double d = Math.Sqrt(dx * dx + dy * dy);
            if (d < 1)
            {
                DurationMs = 0;
                _x1 = _x2 = x3; _y1 = _y2 = y3;
                return;
            }
            double logical = d / scale;
            DurationMs = Math.Max(180, Math.Min(950, 200 + 115 * Math.Log(1 + logical / 35.0, 2)));
            double nx = -dy / d, ny = dx / d;
            double side = dx >= 0 ? -1 : 1;
            double arc = Math.Min(0.14 * d, 110 * scale) * side * (0.7 + 0.6 * rng.NextDouble());
            _x1 = x0 + dx * 0.28 + nx * arc; _y1 = y0 + dy * 0.28 + ny * arc;
            _x2 = x0 + dx * 0.78 + nx * arc * 0.55; _y2 = y0 + dy * 0.78 + ny * arc * 0.55;
        }

        /// <summary>Position at time now; returns true once the journey is over.</summary>
        public bool At(double now, out double x, out double y)
        {
            double t = DurationMs <= 0 ? 1 : Math.Max(0, Math.Min(1, (now - StartMs) / DurationMs));
            double s = t * t * t * (10 - 15 * t + 6 * t * t);
            double u = 1 - s;
            x = u * u * u * _x0 + 3 * u * u * s * _x1 + 3 * u * s * s * _x2 + s * s * s * _x3;
            y = u * u * u * _y0 + 3 * u * u * s * _y1 + 3 * u * s * s * _y2 + s * s * s * _y3;
            return t >= 1;
        }
    }

    /// <summary>State the agent publishes, read back from the JSON file.</summary>
    public class ControlState
    {
        public bool Active;
        public string Agent = "";
        public string Action = "";
        public DateTime Started = DateTime.MinValue;
        public DateTime Heartbeat = DateTime.MinValue;
        public bool ReleaseRequested;
        public string Color = "";
        public int Thickness;
        public bool ShowCursor = true;
        public bool ShowEdges = true;
        public string PanelPosition = "TopCenter";

        public int CursorSeq;
        public string CursorAction = "";
        public int CursorX, CursorY, CursorToX, CursorToY;
        public string CursorWindow = "";
        public DateTime CursorIssued = DateTime.MinValue;

        private static string Str(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Unescape(m.Groups[1].Value) : null;
        }

        private static bool? Bool(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(true|false)", RegexOptions.IgnoreCase);
            if (!m.Success) return null;
            return m.Groups[1].Value.ToLowerInvariant() == "true";
        }

        public static int? Int(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(-?[0-9]+)");
            if (!m.Success) return null;
            return int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        }

        private static string Unescape(string s)
        {
            StringBuilder sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] != '\\' || i + 1 >= s.Length) { sb.Append(s[i]); continue; }
                char n = s[++i];
                if (n == 'n') sb.Append('\n');
                else if (n == 't') sb.Append('\t');
                else if (n == 'r') sb.Append('\r');
                else if (n == 'u' && i + 4 < s.Length)
                {
                    sb.Append((char)int.Parse(s.Substring(i + 1, 4), NumberStyles.HexNumber,
                        CultureInfo.InvariantCulture));
                    i += 4;
                }
                else sb.Append(n);
            }
            return sb.ToString();
        }

        private static DateTime Time(string json, string key)
        {
            string raw = Str(json, key);
            DateTime parsed;
            if (raw != null && DateTime.TryParse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind, out parsed)) return parsed.ToLocalTime();
            return DateTime.MinValue;
        }

        public static string ReadShared(string path)
        {
            try
            {
                using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete))
                using (StreamReader reader = new StreamReader(fs))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }

        public static ControlState Read(string path)
        {
            string json = ReadShared(path);
            if (json == null) return null;

            ControlState s = new ControlState();
            bool? active = Bool(json, "active");
            s.Active = active.HasValue ? active.Value : false;
            s.Agent = Str(json, "agent") ?? "Agent";
            s.Action = Str(json, "action") ?? "";
            s.Started = Time(json, "started");
            s.Heartbeat = Time(json, "heartbeat");
            bool? release = Bool(json, "release_requested");
            s.ReleaseRequested = release.HasValue && release.Value;
            s.Color = Str(json, "color") ?? "#FF9A1F";
            int? thickness = Int(json, "thickness");
            s.Thickness = thickness.HasValue ? thickness.Value : 0;
            bool? cursor = Bool(json, "show_cursor");
            s.ShowCursor = !cursor.HasValue || cursor.Value;
            bool? edges = Bool(json, "show_edges");
            s.ShowEdges = !edges.HasValue || edges.Value;
            s.PanelPosition = Str(json, "panel_position") ?? "TopCenter";

            s.CursorSeq = Int(json, "cursor_seq") ?? 0;
            s.CursorAction = Str(json, "cursor_action") ?? "";
            s.CursorX = Int(json, "cursor_x") ?? 0;
            s.CursorY = Int(json, "cursor_y") ?? 0;
            s.CursorToX = Int(json, "cursor_to_x") ?? 0;
            s.CursorToY = Int(json, "cursor_to_y") ?? 0;
            s.CursorWindow = Str(json, "cursor_window") ?? "";
            s.CursorIssued = Time(json, "cursor_issued");
            return s;
        }
    }

    public class StatusPanel : Form
    {
        private readonly Button _release;
        private readonly double _scale;
        private string _agent = "Agent";
        private string _action = "";
        private string _elapsed = "";
        private Color _accent = Color.FromArgb(255, 154, 31);
        private bool _waiting;

        public bool ReleaseClicked { get; private set; }

        public StatusPanel(double scale, Rectangle screen, string position)
        {
            _scale = scale;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            BackColor = Color.FromArgb(18, 18, 20);
            DoubleBuffered = true;

            int w = S(560), h = S(64);
            Size = new Size(w, h);
            Location = Place(screen, w, h, position);

            _release = new Button();
            _release.Text = "Release";
            _release.FlatStyle = FlatStyle.Flat;
            _release.FlatAppearance.BorderSize = 1;
            _release.FlatAppearance.BorderColor = Color.FromArgb(92, 92, 98);
            _release.BackColor = Color.FromArgb(34, 34, 38);
            _release.ForeColor = Color.FromArgb(226, 226, 230);
            _release.Font = new Font("Segoe UI", (float)(8.5 * _scale), FontStyle.Regular);
            _release.Size = new Size(S(86), S(30));
            _release.Location = new Point(w - S(86) - S(14), (h - S(30)) / 2);
            _release.TabStop = false;
            _release.Click += delegate { ReleaseClicked = true; };
            Controls.Add(_release);
        }

        private int S(int v) { return (int)Math.Round(v * _scale); }

        private Point Place(Rectangle screen, int w, int h, string position)
        {
            int inset = S(52);
            int left = position.EndsWith("Right", StringComparison.OrdinalIgnoreCase)
                ? screen.Right - w - inset
                : screen.Left + (screen.Width - w) / 2;
            int top = position.StartsWith("Bottom", StringComparison.OrdinalIgnoreCase)
                ? screen.Bottom - h - S(72)
                : screen.Top + inset;
            return new Point(left, top);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Native.EX_PANEL;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        public void Update(string agent, string action, string elapsed, Color accent, bool waiting)
        {
            bool changed = _agent != agent || _action != action || _elapsed != elapsed
                || _accent != accent || _waiting != waiting;
            _agent = agent; _action = action; _elapsed = elapsed;
            _accent = accent; _waiting = waiting;
            if (changed) Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            g.Clear(Color.FromArgb(18, 18, 20));

            using (Pen border = new Pen(_accent, S(2)))
            {
                g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            }

            int dot = S(10);
            int dotX = S(16), dotY = (Height - dot) / 2;
            using (SolidBrush brush = new SolidBrush(_waiting ? Color.FromArgb(120, _accent) : _accent))
            {
                g.FillEllipse(brush, dotX, dotY, dot, dot);
            }

            int textLeft = dotX + dot + S(12);
            int textRight = _release.Left - S(12);
            using (Font head = new Font("Segoe UI", (float)(8.0 * _scale), FontStyle.Regular))
            using (Font body = new Font("Segoe UI", (float)(10.0 * _scale), FontStyle.Regular))
            using (SolidBrush dim = new SolidBrush(Color.FromArgb(150, 150, 158)))
            using (SolidBrush bright = new SolidBrush(Color.FromArgb(238, 238, 242)))
            {
                // Keep this file ASCII: Add-Type reads it with the console's default encoding.
                string header = _agent.ToUpperInvariant() + "  -  IN CONTROL";
                if (_elapsed.Length > 0) header += "  -  " + _elapsed;
                if (_waiting) header += "  -  WAITING";
                g.DrawString(header, head, dim, new RectangleF(textLeft, S(10),
                    textRight - textLeft, S(18)));

                StringFormat fmt = new StringFormat();
                fmt.Trimming = StringTrimming.EllipsisCharacter;
                fmt.FormatFlags = StringFormatFlags.NoWrap;
                g.DrawString(_action.Length > 0 ? _action : "-", body, bright,
                    new RectangleF(textLeft, S(28), textRight - textLeft, S(26)), fmt);
            }
        }
    }

    public class Overlay
    {
        private enum StepKind { Check, Glide, Wait, Save, Jump, Down, Up, Restore, Press, Pulse, Ack }

        private class Step
        {
            public StepKind Kind;
            public int X, Y, Ms;
            public bool Right, RealFollows;
            public Step(StepKind kind) { Kind = kind; }
        }

        private readonly string _statePath;
        private readonly string _ackPath;
        private readonly Rectangle _screen;
        private readonly double _scale;
        private readonly int _idleExitMinutes;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly Random _rng = new Random();

        private LayeredOverlay[] _edges;
        private LayeredOverlay _cursorWindow;
        private CursorSprite _sprite;
        private Graphics _cursorGraphics;
        private StatusPanel _panel;
        private ControlState _state;
        private Color _accent = Color.Empty;
        private int _thickness;
        private int _tick;
        private byte _lastEdgeAlpha = 0;
        private DateTime _lastGoodRead = DateTime.Now;
        private bool _waiting;

        // The agent's pointer.
        private double _vx, _vy, _prevX, _prevT, _tilt, _restSince, _shownAt;
        private double _pressStart = -1, _pulseStart = -1;
        private Glide _glide;
        private bool _realFollows;

        // The command being carried out.
        private int _lastSeq;
        private int _commandSeq;
        private List<Step> _steps;
        private int _stepIndex;
        private bool _stepStarted;
        private double _stepStart;
        private string _targetInfo = "";
        private double _commandStart;
        private double _lastFrame;
        private readonly StringBuilder _trace = new StringBuilder();
        private readonly Dictionary<uint, string> _processNames = new Dictionary<uint, string>();
        private Native.POINT _savedReal;
        private bool _hasSavedReal;
        private bool _buttonDown, _buttonRight;

        public Overlay(string statePath, int idleExitMinutes)
        {
            _statePath = statePath;
            _ackPath = Path.Combine(Path.GetDirectoryName(statePath), "cursor_ack.json");
            _idleExitMinutes = idleExitMinutes;
            _screen = Screen.PrimaryScreen.Bounds;
            double s = _screen.Height / 1080.0;
            _scale = Math.Max(1.0, Math.Min(2.0, s));
        }

        public static void Run(string statePath, int idleExitMinutes)
        {
            Native.UseRealPixels();
            Application.EnableVisualStyles();
            new Overlay(statePath, idleExitMinutes).Start();
        }

        private void Start()
        {
            _state = ControlState.Read(_statePath);
            if (_state == null || !_state.Active) return;

            _thickness = _state.Thickness > 0 ? _state.Thickness : (int)Math.Round(28 * _scale);
            _lastSeq = ReadAckSeq();

            _edges = new LayeredOverlay[4];
            for (int i = 0; i < 4; i++) { _edges[i] = new LayeredOverlay(); _edges[i].Show(); }

            // Sized to sit close to the system arrow rather than to the rest of the overlay.
            _sprite = new CursorSprite(_scale * 0.72);
            _cursorWindow = new LayeredOverlay();
            _cursorGraphics = Graphics.FromImage(_cursorWindow.UseCanvas(_sprite.Size, _sprite.Size));
            _cursorWindow.Show();
            Native.POINT start = RealPointer.Where();
            _vx = _prevX = start.X; _vy = start.Y;
            _shownAt = _restSince = _prevT = _clock.Elapsed.TotalMilliseconds;

            _panel = new StatusPanel(_scale, _screen, _state.PanelPosition);
            _panel.Show();

            ApplyAccent(Accent(_state));

            Timer timer = new Timer();
            timer.Interval = 15;
            timer.Tick += delegate { Frame(timer); };
            timer.Start();
            Application.Run();
        }

        private static Color Accent(ControlState state)
        {
            if (state.ReleaseRequested) return Color.FromArgb(232, 62, 62);
            try
            {
                return ColorTranslator.FromHtml(state.Color);
            }
            catch (Exception) { return Color.FromArgb(255, 154, 31); }
        }

        private void ApplyAccent(Color color)
        {
            if (_accent == color) return;
            _accent = color;
            SetEdge(0, _screen.Width, _thickness, Artwork.Edge.Top);
            SetEdge(1, _screen.Width, _thickness, Artwork.Edge.Bottom);
            SetEdge(2, _thickness, _screen.Height, Artwork.Edge.Left);
            SetEdge(3, _thickness, _screen.Height, Artwork.Edge.Right);
            _lastEdgeAlpha = 0;
        }

        private void SetEdge(int index, int width, int height, Artwork.Edge edge)
        {
            using (Bitmap bmp = Artwork.EdgeGlow(width, height, _accent, edge, _thickness))
            {
                _edges[index].SetArtwork(bmp);
            }
        }

        private void Frame(Timer timer)
        {
            _tick++;
            double now = _clock.Elapsed.TotalMilliseconds;
            if (_steps != null && now - _lastFrame > 400)
                _trace.Append(" [frame gap ").Append((int)(now - _lastFrame)).Append("ms]");
            _lastFrame = now;

            // The file is read about twenty times a second; the pointer animates every tick.
            if (_tick % 3 == 1)
            {
                ControlState fresh = ControlState.Read(_statePath);
                if (fresh == null)
                {
                    // A momentary read failure is a write in progress; a persistent one means gone.
                    if ((DateTime.Now - _lastGoodRead).TotalSeconds > 5) { Quit(timer); return; }
                }
                else
                {
                    _lastGoodRead = DateTime.Now;
                    _state = fresh;
                    if (!_state.Active) { Quit(timer); return; }

                    double idleSeconds = _state.Heartbeat == DateTime.MinValue
                        ? 0 : (DateTime.Now - _state.Heartbeat).TotalSeconds;
                    if (idleSeconds > _idleExitMinutes * 60.0) { Quit(timer); return; }
                    _waiting = idleSeconds > 25 && _steps == null;

                    if (_panel.ReleaseClicked) RequestRelease();
                    ApplyAccent(Accent(_state));
                    _panel.Update(_state.Agent, _state.Action, Elapsed(_state.Started), _accent, _waiting);
                    TakeCommand(now);
                }
            }

            RunSteps(now);

            // Masked because TickCount goes negative after 24.9 days of uptime.
            double phase = ((Environment.TickCount & int.MaxValue) % 2400) / 2400.0;
            double wave = 0.5 - 0.5 * Math.Cos(phase * 2 * Math.PI);

            if (_state.ShowEdges)
            {
                byte edgeAlpha = (byte)Math.Round(95 + 85 * wave);
                if (edgeAlpha != _lastEdgeAlpha && _tick % 4 == 0)
                {
                    _lastEdgeAlpha = edgeAlpha;
                    _edges[0].Push(_screen.Left, _screen.Top, edgeAlpha);
                    _edges[1].Push(_screen.Left, _screen.Bottom - _thickness, edgeAlpha);
                    _edges[2].Push(_screen.Left, _screen.Top, edgeAlpha);
                    _edges[3].Push(_screen.Right - _thickness, _screen.Top, edgeAlpha);
                }
            }

            AnimateCursor(now, wave);

            if (_tick % 60 == 0) KeepOnTop();
        }

        private void AnimateCursor(double now, double wave)
        {
            if (_glide != null)
            {
                bool done = _glide.At(now, out _vx, out _vy);
                if (_realFollows)
                {
                    if (_state.ReleaseRequested)
                    {
                        Abort(true, "Release was requested during the drag; the button was let go.");
                    }
                    else RealPointer.MoveTo((int)Math.Round(_vx), (int)Math.Round(_vy), true);
                }
                if (done) { _glide = null; _realFollows = false; _restSince = now; }
            }

            // Lean with sideways speed, as a hand-held pointer would, then settle upright.
            double dt = Math.Max(1, now - _prevT);
            double speed = (_vx - _prevX) / dt * 1000.0 / _scale;
            _prevX = _vx; _prevT = now;
            double lean = Math.Max(-18, Math.Min(18, speed * 0.012));
            _tilt += (lean - _tilt) * (1 - Math.Exp(-dt / 90.0));

            // At rest, a small sway about the tip shows the agent is still at work.
            double rest = _glide == null ? Math.Max(0, Math.Min(1, (now - _restSince - 250) / 400.0)) : 0;
            double sway = (_waiting ? 4 : 9) * rest * Math.Sin(now / 1400.0 * 2 * Math.PI);

            double press = 1.0;
            if (_pressStart >= 0)
            {
                double p = (now - _pressStart) / 180.0;
                if (p >= 1) _pressStart = -1;
                else press = 1.0 - 0.14 * Math.Sin(p * Math.PI);
            }
            double pulse = -1;
            if (_pulseStart >= 0)
            {
                double p = (now - _pulseStart) / 420.0;
                if (p >= 1) _pulseStart = -1;
                else pulse = p;
            }

            if (!_state.ShowCursor)
            {
                _cursorWindow.Push(0, 0, 0);
                return;
            }
            double fog = _glide != null ? 1.0 : 0.55 + 0.45 * wave;
            _sprite.Render(_cursorGraphics, _tilt + sway, press, fog, pulse, _accent);
            byte alpha = (byte)Math.Round(255 * Math.Min(1.0, (now - _shownAt) / 300.0));
            int half = _sprite.Size / 2;
            _cursorWindow.Push((int)Math.Round(_vx) - half, (int)Math.Round(_vy) - half, alpha);
        }

        private void TakeCommand(double now)
        {
            // A fresh 'start' resets the sequence; everything after it is new.
            if (_state.CursorSeq < _lastSeq) _lastSeq = 0;
            if (_steps != null || _state.CursorSeq <= _lastSeq) return;
            _lastSeq = _state.CursorSeq;
            _commandSeq = _state.CursorSeq;
            _targetInfo = "";

            if (_state.CursorIssued != DateTime.MinValue
                && (DateTime.Now - _state.CursorIssued).TotalSeconds > 20)
            {
                WriteAck(false, false, "The pointer command was too old to run safely, so it was skipped.");
                return;
            }
            if (!RealPointer.InputSizeIsRight)
            {
                WriteAck(false, false, "Windows input cannot be sent from this process (INPUT is "
                    + Marshal.SizeOf(typeof(Native.INPUT)) + " bytes).");
                return;
            }
            _steps = Plan(_state);
            if (_steps == null)
            {
                WriteAck(false, false, "Unknown pointer command '" + _state.CursorAction + "'.");
                return;
            }
            _stepIndex = 0;
            _stepStarted = false;
            _commandStart = now;
            _trace.Length = 0;
        }

        private List<Step> Plan(ControlState s)
        {
            string kind = (s.CursorAction ?? "").ToLowerInvariant();
            int x = s.CursorX, y = s.CursorY;
            List<Step> p = new List<Step>();
            if (kind == "move")
            {
                p.Add(GlideTo(x, y, false));
            }
            else if (kind == "point")
            {
                // Looks like a click, touches nothing: for demonstrations.
                p.Add(GlideTo(x, y, false));
                p.Add(Wait(70));
                p.Add(new Step(StepKind.Press));
                p.Add(new Step(StepKind.Pulse));
                p.Add(Wait(320));
            }
            else if (kind == "click" || kind == "right" || kind == "double")
            {
                bool right = kind == "right";
                p.Add(At(StepKind.Check, x, y));
                p.Add(GlideTo(x, y, false));
                p.Add(Wait(70));
                p.Add(At(StepKind.Check, x, y));
                p.Add(new Step(StepKind.Save));
                p.Add(At(StepKind.Jump, x, y));
                p.Add(Wait(25));
                p.Add(new Step(StepKind.Press));
                p.Add(ButtonStep(StepKind.Down, right));
                p.Add(Wait(45));
                p.Add(ButtonStep(StepKind.Up, right));
                if (kind == "double")
                {
                    p.Add(Wait(55));
                    p.Add(ButtonStep(StepKind.Down, false));
                    p.Add(Wait(30));
                    p.Add(ButtonStep(StepKind.Up, false));
                }
                p.Add(Wait(40));
                p.Add(new Step(StepKind.Restore));
                p.Add(new Step(StepKind.Pulse));
                p.Add(Wait(160));
            }
            else if (kind == "drag")
            {
                p.Add(At(StepKind.Check, x, y));
                p.Add(GlideTo(x, y, false));
                p.Add(Wait(70));
                p.Add(At(StepKind.Check, x, y));
                p.Add(new Step(StepKind.Save));
                p.Add(At(StepKind.Jump, x, y));
                p.Add(Wait(40));
                p.Add(new Step(StepKind.Press));
                p.Add(ButtonStep(StepKind.Down, false));
                p.Add(Wait(80));
                p.Add(GlideTo(s.CursorToX, s.CursorToY, true));
                p.Add(Wait(90));
                p.Add(ButtonStep(StepKind.Up, false));
                p.Add(Wait(40));
                p.Add(new Step(StepKind.Restore));
                p.Add(new Step(StepKind.Pulse));
                p.Add(Wait(160));
            }
            else return null;
            p.Add(new Step(StepKind.Ack));
            return p;
        }

        private static Step At(StepKind kind, int x, int y)
        {
            Step s = new Step(kind); s.X = x; s.Y = y; return s;
        }

        private static Step GlideTo(int x, int y, bool realFollows)
        {
            Step s = At(StepKind.Glide, x, y); s.RealFollows = realFollows; return s;
        }

        private static Step Wait(int ms)
        {
            Step s = new Step(StepKind.Wait); s.Ms = ms; return s;
        }

        private static Step ButtonStep(StepKind kind, bool right)
        {
            Step s = new Step(kind); s.Right = right; return s;
        }

        private void RunSteps(double now)
        {
            while (_steps != null && _stepIndex < _steps.Count)
            {
                Step s = _steps[_stepIndex];
                if (!_stepStarted)
                {
                    _stepStarted = true;
                    _stepStart = now;
                    _trace.Append(' ').Append(s.Kind).Append('@')
                        .Append(((int)(now - _commandStart)).ToString(CultureInfo.InvariantCulture));
                    double began = _clock.Elapsed.TotalMilliseconds;
                    if (!StartStep(s, now)) return;
                    double took = _clock.Elapsed.TotalMilliseconds - began;
                    if (took > 50) _trace.Append("(took ").Append((int)took).Append(')');
                }
                if (s.Kind == StepKind.Glide && _glide != null) return;
                if (s.Kind == StepKind.Wait && now - _stepStart < s.Ms) return;
                _stepIndex++;
                _stepStarted = false;
            }
            _steps = null;
        }

        /// <summary>Begins a step; returns false when it aborted the command.</summary>
        private bool StartStep(Step s, double now)
        {
            switch (s.Kind)
            {
                case StepKind.Check:
                    return CheckTarget(s.X, s.Y);
                case StepKind.Glide:
                    _glide = new Glide(_vx, _vy, s.X, s.Y, _scale, now, _rng);
                    _realFollows = s.RealFollows;
                    return true;
                case StepKind.Save:
                    _savedReal = RealPointer.Where();
                    _hasSavedReal = true;
                    return true;
                case StepKind.Jump:
                    if (_state.ReleaseRequested)
                    {
                        Abort(true, "Release was requested, so nothing was clicked.");
                        return false;
                    }
                    if (!RealPointer.MoveTo(s.X, s.Y, false))
                    {
                        Abort(false, "The real pointer could not be moved to the target.");
                        return false;
                    }
                    return true;
                case StepKind.Down:
                    if (!RealPointer.Button(s.Right, true))
                    {
                        Abort(false, "Windows refused the button press (error "
                            + Marshal.GetLastWin32Error() + ").");
                        return false;
                    }
                    _buttonDown = true;
                    _buttonRight = s.Right;
                    return true;
                case StepKind.Up:
                    RealPointer.Button(s.Right, false);
                    _buttonDown = false;
                    return true;
                case StepKind.Restore:
                    RestoreReal();
                    return true;
                case StepKind.Press:
                    _pressStart = now;
                    return true;
                case StepKind.Pulse:
                    _pulseStart = now;
                    return true;
                case StepKind.Ack:
                    WriteAck(true, false, "");
                    return true;
            }
            return true;
        }

        private bool CheckTarget(int x, int y)
        {
            if (_panel.Bounds.Contains(x, y))
            {
                Abort(false, "The target is under the status panel. Move the panel with -Position.");
                return false;
            }
            Native.POINT p = new Native.POINT(); p.X = x; p.Y = y;
            IntPtr hwnd = Native.WindowFromPoint(p);
            IntPtr root = hwnd == IntPtr.Zero ? IntPtr.Zero : Native.GetAncestor(hwnd, Native.GA_ROOT);
            string title = "", process = "";
            if (root != IntPtr.Zero)
            {
                StringBuilder sb = new StringBuilder(256);
                Native.GetWindowText(root, sb, sb.Capacity);
                title = sb.ToString();
                uint pid;
                Native.GetWindowThreadProcessId(root, out pid);
                process = ProcessName(pid);
            }
            _targetInfo = process.Length == 0 ? title
                : (title.Length > 0 ? title + " (" + process + ")" : process);

            string want = _state.CursorWindow ?? "";
            if (want.Length > 0
                && title.IndexOf(want, StringComparison.OrdinalIgnoreCase) < 0
                && process.IndexOf(want, StringComparison.OrdinalIgnoreCase) < 0)
            {
                Abort(false, "The target is in '" + _targetInfo + "', not '" + want
                    + "', so nothing was clicked.");
                return false;
            }
            return true;
        }

        /// <summary>
        /// Looking a process up costs about 100 ms on this many-session server, and the check runs
        /// just before the real pointer is borrowed, so names are remembered per process id.
        /// </summary>
        private string ProcessName(uint pid)
        {
            string name;
            if (_processNames.TryGetValue(pid, out name)) return name;
            name = "";
            try { name = Process.GetProcessById((int)pid).ProcessName; }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            if (_processNames.Count > 200) _processNames.Clear();
            _processNames[pid] = name;
            return name;
        }

        private void Abort(bool released, string message)
        {
            ReleaseInput();
            _glide = null;
            _realFollows = false;
            _restSince = _clock.Elapsed.TotalMilliseconds;
            _steps = null;
            WriteAck(false, released, message);
        }

        /// <summary>Lets go of any held button and hands the real pointer back.</summary>
        private void ReleaseInput()
        {
            if (_buttonDown)
            {
                RealPointer.Button(_buttonRight, false);
                _buttonDown = false;
            }
            RestoreReal();
        }

        private void RestoreReal()
        {
            if (!_hasSavedReal) return;
            Native.SetCursorPos(_savedReal.X, _savedReal.Y);
            _hasSavedReal = false;
        }

        private int ReadAckSeq()
        {
            string json = ControlState.ReadShared(_ackPath);
            if (json == null) return 0;
            return ControlState.Int(json, "seq") ?? 0;
        }

        private void WriteAck(bool ok, bool released, string message)
        {
            // One line per command with when each step began, so a slow step can be found later.
            try
            {
                File.AppendAllText(Path.Combine(Path.GetDirectoryName(_ackPath), "overlay.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                    + " seq " + _commandSeq + " " + _state.CursorAction + " " + (ok ? "ok" : "failed")
                    + " total " + (int)(_clock.Elapsed.TotalMilliseconds - _commandStart) + "ms:"
                    + _trace + (message.Length > 0 ? " | " + message : "") + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }

            string json = "{\"seq\": " + _commandSeq.ToString(CultureInfo.InvariantCulture)
                + ", \"ok\": " + (ok ? "true" : "false")
                + ", \"released\": " + (released ? "true" : "false")
                + ", \"message\": \"" + Escape(message) + "\""
                + ", \"window\": \"" + Escape(_targetInfo) + "\"}";
            string tmp = _ackPath + ".tmp";
            try
            {
                File.WriteAllText(tmp, json);
                if (File.Exists(_ackPath)) File.Delete(_ackPath);
                File.Move(tmp, _ackPath);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private static string Escape(string s)
        {
            StringBuilder sb = new StringBuilder();
            foreach (char ch in s ?? "")
            {
                if (ch == '\\' || ch == '"') sb.Append('\\').Append(ch);
                else if (ch < ' ') sb.Append(' ');
                else if (ch > '~') sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(ch);
            }
            return sb.ToString();
        }

        private static string Elapsed(DateTime started)
        {
            if (started == DateTime.MinValue) return "";
            TimeSpan d = DateTime.Now - started;
            if (d.TotalSeconds < 0) return "";
            if (d.TotalHours >= 1)
                return string.Format(CultureInfo.InvariantCulture, "{0}h {1:00}m",
                    (int)d.TotalHours, d.Minutes);
            return string.Format(CultureInfo.InvariantCulture, "{0}m {1:00}s",
                (int)d.TotalMinutes, d.Seconds);
        }

        /// <summary>Other apps steal the top of the z-order, so claim it back periodically.</summary>
        private void KeepOnTop()
        {
            uint flags = Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE;
            for (int i = 0; i < _edges.Length; i++)
                Native.SetWindowPos(_edges[i].Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, flags);
            Native.SetWindowPos(_cursorWindow.Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, flags);
            Native.SetWindowPos(_panel.Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, flags);
        }

        private void RequestRelease()
        {
            try
            {
                string json = File.ReadAllText(_statePath);
                if (Regex.IsMatch(json, "\"release_requested\"\\s*:\\s*true")) return;
                json = Regex.Replace(json, "\"release_requested\"\\s*:\\s*false",
                    "\"release_requested\":  true");
                File.WriteAllText(_statePath, json);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private void Quit(Timer timer)
        {
            timer.Stop();
            if (_steps != null) Abort(false, "The overlay was stopped before the pointer command finished.");
            else ReleaseInput();
            Application.Exit();
        }
    }
}
