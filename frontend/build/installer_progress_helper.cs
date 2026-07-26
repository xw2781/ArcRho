using System;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[assembly: AssemblyTitle("ArcRho Installer Progress Observer")]
[assembly: AssemblyDescription("Reads the native NSIS progress control for the ArcRho installer.")]
[assembly: AssemblyCompany("ArcRho")]
[assembly: AssemblyProduct("ArcRho")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class ArcRhoInstallerProgress
{
    private const uint WM_SETTEXT = 0x000C;
    private const uint WM_GETTEXT = 0x000D;
    private const uint WM_NEXTDLGCTL = 0x0028;
    private const uint PBM_GETRANGE = 0x0407;
    private const uint PBM_GETPOS = 0x0408;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const uint SW_HIDE = 0;
    private const uint SW_SHOW = 5;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint MessageTimeoutMilliseconds = 100;
    private const int PollIntervalMilliseconds = 200;
    private const int StartupDelayMilliseconds = 200;
    private const int MaximumConsecutiveMessageFailures = 20;
    private const double EtaUpdateIntervalSeconds = 5.0;
    private const double MaximumDisplayedEtaSeconds = 5.0 * 60.0;

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowRectangle
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;

        internal int Width
        {
            get { return Right - Left; }
        }

        internal int Height
        {
            get { return Bottom - Top; }
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsChild(IntPtr parent, IntPtr child);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(
        IntPtr window,
        out uint processId
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(
        IntPtr window,
        out WindowRectangle rectangle
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int MapWindowPoints(
        IntPtr fromWindow,
        IntPtr toWindow,
        ref WindowRectangle points,
        uint pointCount
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr window,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ShowWindow(IntPtr window, uint command);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport(
        "user32.dll",
        EntryPoint = "PostMessageW",
        CharSet = CharSet.Unicode,
        ExactSpelling = true,
        SetLastError = true
    )]
    private static extern bool PostWindowMessage(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam
    );

    [DllImport(
        "user32.dll",
        EntryPoint = "SendMessageTimeoutW",
        CharSet = CharSet.Unicode,
        ExactSpelling = true,
        SetLastError = true
    )]
    private static extern IntPtr SendNumericMessageTimeout(
        IntPtr window,
        uint message,
        UIntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out UIntPtr result
    );

    [DllImport(
        "user32.dll",
        EntryPoint = "SendMessageTimeoutW",
        CharSet = CharSet.Unicode,
        ExactSpelling = true,
        SetLastError = true
    )]
    private static extern IntPtr SendTextMessageTimeout(
        IntPtr window,
        uint message,
        UIntPtr wParam,
        string text,
        uint flags,
        uint timeout,
        out UIntPtr result
    );

    [DllImport(
        "user32.dll",
        EntryPoint = "SendMessageTimeoutW",
        CharSet = CharSet.Unicode,
        ExactSpelling = true,
        SetLastError = true
    )]
    private static extern IntPtr SendBufferMessageTimeout(
        IntPtr window,
        uint message,
        UIntPtr wParam,
        [Out] StringBuilder text,
        uint flags,
        uint timeout,
        out UIntPtr result
    );

    private sealed class ProgressSample
    {
        internal long Low;
        internal long High;
        internal long Position;
    }

    private sealed class DetailsToggle : IDisposable
    {
        private const int ListPadding = 4;
        private const int MaximumButtonTextLength = 256;
        private const string HideDetailsText = "Hide details";

        private readonly IntPtr installerWindow;
        private readonly IntPtr pageWindow;
        private readonly IntPtr detailsListWindow;
        private readonly IntPtr nativeDetailsButton;
        private readonly string showDetailsText;
        private WindowRectangle collapsedButtonRectangle;
        private WindowRectangle expandedListRectangle;
        private bool hasExpandedListRectangle;
        private bool isExpanded;

        internal DetailsToggle(
            IntPtr installerWindow,
            IntPtr pageWindow,
            IntPtr detailsListWindow,
            IntPtr nativeDetailsButton
        )
        {
            this.installerWindow = installerWindow;
            this.pageWindow = pageWindow;
            this.detailsListWindow = detailsListWindow;
            this.nativeDetailsButton = nativeDetailsButton;
            showDetailsText = ReadWindowText(nativeDetailsButton);
            TryGetRelativeRectangle(
                nativeDetailsButton,
                pageWindow,
                out collapsedButtonRectangle
            );
        }

        internal void Update()
        {
            bool listVisible = IsWindowVisible(detailsListWindow);
            bool buttonVisible = IsWindowVisible(nativeDetailsButton);
            // NSIS's native IDC_SHOWDETAILS command is one-way: it hides this
            // button and shows the list. Reuse that exact control for the Hide
            // state, then treat NSIS hiding it again as the collapse request.
            if (
                showDetailsText.Length > 0
                && ShouldExpandDetails(isExpanded, listVisible, buttonVisible)
            )
            {
                Expand();
                return;
            }

            if (ShouldCollapseDetails(isExpanded, buttonVisible))
            {
                Collapse();
                return;
            }

            if (isExpanded && !listVisible)
            {
                Collapse();
            }
        }

        private void Expand()
        {
            WindowRectangle listRectangle;
            if (
                collapsedButtonRectangle.Width <= 0
                || collapsedButtonRectangle.Height <= 0
                || !TryGetRelativeRectangle(
                    detailsListWindow,
                    pageWindow,
                    out listRectangle
                )
            )
            {
                return;
            }

            expandedListRectangle = listRectangle;
            hasExpandedListRectangle = true;
            int adjustedBottom = Math.Max(
                listRectangle.Top + 1,
                listRectangle.Bottom
                    - collapsedButtonRectangle.Height
                    - ListPadding
            );
            bool listPositioned = SetWindowPos(
                detailsListWindow,
                IntPtr.Zero,
                listRectangle.Left,
                listRectangle.Top,
                listRectangle.Width,
                adjustedBottom - listRectangle.Top,
                SWP_NOZORDER | SWP_NOACTIVATE
            );

            bool buttonPositioned = SetWindowPos(
                nativeDetailsButton,
                IntPtr.Zero,
                listRectangle.Left,
                adjustedBottom + ListPadding,
                collapsedButtonRectangle.Width,
                collapsedButtonRectangle.Height,
                SWP_NOZORDER | SWP_NOACTIVATE
            );
            bool textUpdated = TrySetWindowText(
                nativeDetailsButton,
                HideDetailsText
            );
            ShowWindow(nativeDetailsButton, SW_SHOW);
            if (
                !listPositioned
                || !buttonPositioned
                || !textUpdated
                || !IsWindowVisible(nativeDetailsButton)
            )
            {
                RollBackExpansion();
                return;
            }

            isExpanded = true;
            FocusNativeButton();
        }

        private void Collapse()
        {
            bool listRestored = RestoreExpandedListRectangle();
            ShowWindow(detailsListWindow, SW_HIDE);
            if (listRestored && RestoreNativeButton(true))
            {
                hasExpandedListRectangle = false;
                isExpanded = false;
            }
        }

        private bool RestoreNativeButton(bool show)
        {
            bool positioned = SetWindowPos(
                nativeDetailsButton,
                IntPtr.Zero,
                collapsedButtonRectangle.Left,
                collapsedButtonRectangle.Top,
                collapsedButtonRectangle.Width,
                collapsedButtonRectangle.Height,
                SWP_NOZORDER | SWP_NOACTIVATE
            );
            bool textUpdated = TrySetWindowText(
                nativeDetailsButton,
                showDetailsText
            );
            ShowWindow(nativeDetailsButton, show ? SW_SHOW : SW_HIDE);
            bool visibilityMatches = IsWindowVisible(nativeDetailsButton)
                == show;
            if (show && positioned && textUpdated && visibilityMatches)
            {
                FocusNativeButton();
            }
            return positioned && textUpdated && visibilityMatches;
        }

        private bool RestoreExpandedListRectangle()
        {
            return !hasExpandedListRectangle
                || SetWindowPos(
                    detailsListWindow,
                    IntPtr.Zero,
                    expandedListRectangle.Left,
                    expandedListRectangle.Top,
                    expandedListRectangle.Width,
                    expandedListRectangle.Height,
                    SWP_NOZORDER | SWP_NOACTIVATE
                );
        }

        private void RollBackExpansion()
        {
            RestoreExpandedListRectangle();
            RestoreNativeButton(false);
            hasExpandedListRectangle = false;
            isExpanded = false;
        }

        private void FocusNativeButton()
        {
            PostWindowMessage(
                installerWindow,
                WM_NEXTDLGCTL,
                nativeDetailsButton,
                new IntPtr(1)
            );
        }

        public void Dispose()
        {
            if (!isExpanded)
            {
                return;
            }

            RestoreExpandedListRectangle();
            RestoreNativeButton(false);
            hasExpandedListRectangle = false;
            isExpanded = false;
        }

        private static bool TryGetRelativeRectangle(
            IntPtr window,
            IntPtr parent,
            out WindowRectangle rectangle
        )
        {
            if (!GetWindowRect(window, out rectangle))
            {
                return false;
            }
            MapWindowPoints(IntPtr.Zero, parent, ref rectangle, 2);
            return rectangle.Width > 0 && rectangle.Height > 0;
        }

        private static string ReadWindowText(IntPtr window)
        {
            StringBuilder text = new StringBuilder(MaximumButtonTextLength);
            UIntPtr result;
            if (
                SendBufferMessageTimeout(
                    window,
                    WM_GETTEXT,
                    new UIntPtr((uint)text.Capacity),
                    text,
                    SMTO_ABORTIFHUNG,
                    MessageTimeoutMilliseconds,
                    out result
                )
                    == IntPtr.Zero
                || result == UIntPtr.Zero
            )
            {
                return string.Empty;
            }
            return text.ToString();
        }
    }

    private static bool ShouldExpandDetails(
        bool isExpanded,
        bool listVisible,
        bool buttonVisible
    )
    {
        return !isExpanded && listVisible && !buttonVisible;
    }

    private static bool ShouldCollapseDetails(
        bool isExpanded,
        bool buttonVisible
    )
    {
        return isExpanded && !buttonVisible;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test")
        {
            return RunSelfTest();
        }

        if (args.Length != 7)
        {
            return 2;
        }

        IntPtr installerWindow;
        IntPtr pageWindow;
        IntPtr progressWindow;
        IntPtr statusWindow;
        IntPtr detailsListWindow;
        IntPtr detailsButtonWindow;
        uint installerProcessId;

        if (
            !TryParsePointer(args[0], out installerWindow)
            || !TryParsePointer(args[1], out pageWindow)
            || !TryParsePointer(args[2], out progressWindow)
            || !TryParsePointer(args[3], out statusWindow)
            || !TryParsePointer(args[4], out detailsListWindow)
            || !TryParsePointer(args[5], out detailsButtonWindow)
            || !uint.TryParse(
                args[6],
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out installerProcessId
            )
        )
        {
            return 2;
        }

        return Observe(
            installerWindow,
            pageWindow,
            progressWindow,
            statusWindow,
            detailsListWindow,
            detailsButtonWindow,
            installerProcessId
        );
    }

    private static int Observe(
        IntPtr installerWindow,
        IntPtr pageWindow,
        IntPtr progressWindow,
        IntPtr statusWindow,
        IntPtr detailsListWindow,
        IntPtr detailsButtonWindow,
        uint installerProcessId
    )
    {
        long baselinePosition = 0;
        long lastPosition = 0;
        long baselineTimestamp = 0;
        bool hasBaseline = false;
        bool progressMoved = false;
        string lastText = null;
        string estimatedDurationText = null;
        long lastEtaUpdateTimestamp = 0;
        int consecutiveReadFailures = 0;
        int consecutiveWriteFailures = 0;

        // Let the InstFiles page finish its SHOW callback before sending
        // cross-thread window messages to its controls.
        Thread.Sleep(StartupDelayMilliseconds);

        using (
            DetailsToggle detailsToggle = new DetailsToggle(
                installerWindow,
                pageWindow,
                detailsListWindow,
                detailsButtonWindow
            )
        )
        {
            while (
                WindowsAreValid(
                    installerWindow,
                    pageWindow,
                    progressWindow,
                    statusWindow,
                    detailsListWindow,
                    detailsButtonWindow,
                    installerProcessId
                )
            )
            {
                detailsToggle.Update();

                ProgressSample sample;
                if (!TryReadProgress(progressWindow, out sample))
                {
                    consecutiveReadFailures++;
                    if (
                        consecutiveReadFailures
                        >= MaximumConsecutiveMessageFailures
                    )
                    {
                        return 0;
                    }
                    Thread.Sleep(PollIntervalMilliseconds);
                    continue;
                }
                consecutiveReadFailures = 0;

                long now = Stopwatch.GetTimestamp();
                if (!hasBaseline || sample.Position < lastPosition)
                {
                    baselinePosition = sample.Position;
                    baselineTimestamp = now;
                    progressMoved = false;
                    estimatedDurationText = null;
                    lastEtaUpdateTimestamp = 0;
                    hasBaseline = true;
                }
                else if (!progressMoved)
                {
                    if (sample.Position == baselinePosition)
                    {
                        baselineTimestamp = now;
                    }
                    else
                    {
                        progressMoved = true;
                    }
                }

                int percentage = CalculatePercentage(
                    sample.Position,
                    sample.Low,
                    sample.High
                );
                string text = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}% complete - Estimating time left...",
                    percentage
                );

                if (percentage >= 100)
                {
                    text = "100% complete - Finalizing installation...";
                }
                else if (progressMoved)
                {
                    double elapsedSeconds =
                        (now - baselineTimestamp)
                        / (double)Stopwatch.Frequency;
                    long completed = sample.Position - baselinePosition;
                    long remaining = sample.High - sample.Position;
                    double secondsSinceEtaUpdate =
                        lastEtaUpdateTimestamp == 0
                            ? double.MaxValue
                            : (now - lastEtaUpdateTimestamp)
                                / (double)Stopwatch.Frequency;

                    if (
                        elapsedSeconds >= EtaUpdateIntervalSeconds
                        && secondsSinceEtaUpdate
                            >= EtaUpdateIntervalSeconds
                        && completed > 0
                        && remaining >= 0
                    )
                    {
                        double etaSeconds =
                            elapsedSeconds
                            * remaining
                            / (double)completed;
                        estimatedDurationText = FormatDuration(
                            Math.Min(
                                MaximumDisplayedEtaSeconds,
                                Math.Max(0, etaSeconds)
                            )
                        );
                        lastEtaUpdateTimestamp = now;
                    }

                    if (estimatedDurationText != null)
                    {
                        text = string.Format(
                            CultureInfo.InvariantCulture,
                            "{0}% complete - Estimated time left: {1}",
                            percentage,
                            estimatedDurationText
                        );
                    }
                }

                if (text != lastText)
                {
                    if (!TrySetWindowText(statusWindow, text))
                    {
                        consecutiveWriteFailures++;
                        if (
                            consecutiveWriteFailures
                            >= MaximumConsecutiveMessageFailures
                        )
                        {
                            return 0;
                        }
                        Thread.Sleep(PollIntervalMilliseconds);
                        continue;
                    }
                    consecutiveWriteFailures = 0;
                    lastText = text;
                }

                // The bar can reach 100 before final installer actions finish.
                // Keep the details toggle active until the InstFiles page closes.
                lastPosition = sample.Position;
                Thread.Sleep(PollIntervalMilliseconds);
            }
        }

        return 0;
    }

    private static bool WindowsAreValid(
        IntPtr installerWindow,
        IntPtr pageWindow,
        IntPtr progressWindow,
        IntPtr statusWindow,
        IntPtr detailsListWindow,
        IntPtr detailsButtonWindow,
        uint installerProcessId
    )
    {
        if (
            !WindowBelongsToProcess(installerWindow, installerProcessId)
            || !WindowBelongsToProcess(pageWindow, installerProcessId)
            || !WindowBelongsToProcess(progressWindow, installerProcessId)
            || !WindowBelongsToProcess(statusWindow, installerProcessId)
            || !WindowBelongsToProcess(
                detailsListWindow,
                installerProcessId
            )
            || !WindowBelongsToProcess(
                detailsButtonWindow,
                installerProcessId
            )
        )
        {
            return false;
        }

        return IsChild(installerWindow, pageWindow)
            && IsChild(pageWindow, progressWindow)
            && IsChild(pageWindow, statusWindow)
            && IsChild(pageWindow, detailsListWindow)
            && IsChild(pageWindow, detailsButtonWindow);
    }

    private static bool WindowBelongsToProcess(
        IntPtr window,
        uint expectedProcessId
    )
    {
        uint actualProcessId;
        return IsWindow(window)
            && GetWindowThreadProcessId(window, out actualProcessId) != 0
            && actualProcessId == expectedProcessId;
    }

    private static bool TryReadProgress(
        IntPtr progressWindow,
        out ProgressSample sample
    )
    {
        sample = null;
        UIntPtr lowResult;
        UIntPtr highResult;
        UIntPtr positionResult;

        if (
            SendNumericMessageTimeout(
                progressWindow,
                PBM_GETRANGE,
                new UIntPtr(1),
                IntPtr.Zero,
                SMTO_ABORTIFHUNG,
                MessageTimeoutMilliseconds,
                out lowResult
            )
                == IntPtr.Zero
            || SendNumericMessageTimeout(
                progressWindow,
                PBM_GETRANGE,
                UIntPtr.Zero,
                IntPtr.Zero,
                SMTO_ABORTIFHUNG,
                MessageTimeoutMilliseconds,
                out highResult
            )
                == IntPtr.Zero
            || SendNumericMessageTimeout(
                progressWindow,
                PBM_GETPOS,
                UIntPtr.Zero,
                IntPtr.Zero,
                SMTO_ABORTIFHUNG,
                MessageTimeoutMilliseconds,
                out positionResult
            )
                == IntPtr.Zero
        )
        {
            return false;
        }

        long low = unchecked((long)lowResult.ToUInt64());
        long high = unchecked((long)highResult.ToUInt64());
        long position = unchecked((long)positionResult.ToUInt64());
        if (high <= low)
        {
            return false;
        }

        if (position < low)
        {
            position = low;
        }
        else if (position > high)
        {
            position = high;
        }

        sample = new ProgressSample
        {
            Low = low,
            High = high,
            Position = position
        };
        return true;
    }

    private static bool TrySetWindowText(IntPtr window, string text)
    {
        UIntPtr result;
        return SendTextMessageTimeout(
            window,
            WM_SETTEXT,
            UIntPtr.Zero,
            text,
            SMTO_ABORTIFHUNG,
            MessageTimeoutMilliseconds,
            out result
        )
            != IntPtr.Zero;
    }

    private static int CalculatePercentage(long position, long low, long high)
    {
        if (high <= low)
        {
            return 0;
        }

        long clampedPosition = Math.Max(low, Math.Min(high, position));
        return (int)((clampedPosition - low) * 100L / (high - low));
    }

    private static string FormatDuration(double seconds)
    {
        int totalSeconds = Math.Max(1, (int)Math.Ceiling(seconds));
        if (totalSeconds < 60)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0} sec",
                totalSeconds
            );
        }

        if (totalSeconds < 60 * 60)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0} min {1} sec",
                totalSeconds / 60,
                totalSeconds % 60
            );
        }

        return string.Format(
            CultureInfo.InvariantCulture,
            "{0} hr {1} min",
            totalSeconds / (60 * 60),
            (totalSeconds / 60) % 60
        );
    }

    private static bool TryParsePointer(string text, out IntPtr pointer)
    {
        pointer = IntPtr.Zero;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            ulong raw;
            if (
                !ulong.TryParse(
                    text.Substring(2),
                    NumberStyles.AllowHexSpecifier,
                    CultureInfo.InvariantCulture,
                    out raw
                )
            )
            {
                return false;
            }

            if (IntPtr.Size == 4)
            {
                if (raw > uint.MaxValue)
                {
                    return false;
                }
                pointer = new IntPtr(unchecked((int)(uint)raw));
            }
            else
            {
                pointer = new IntPtr(unchecked((long)raw));
            }
        }
        else
        {
            long signed;
            if (
                !long.TryParse(
                    text,
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out signed
                )
            )
            {
                return false;
            }

            if (IntPtr.Size == 4)
            {
                // NSIS is a 32-bit process and formats HWND values as signed
                // decimal integers. Accept both that form and unsigned
                // decimal representations while preserving the low 32 bits.
                if (signed < int.MinValue || signed > uint.MaxValue)
                {
                    return false;
                }
                pointer = new IntPtr(unchecked((int)signed));
            }
            else
            {
                pointer = new IntPtr(signed);
            }
        }

        return pointer != IntPtr.Zero;
    }

    private static int RunSelfTest()
    {
        if (
            CalculatePercentage(0, 0, 30000) != 0
            || CalculatePercentage(15000, 0, 30000) != 50
            || CalculatePercentage(30000, 0, 30000) != 100
            || CalculatePercentage(40000, 0, 30000) != 100
            || FormatDuration(1.1) != "2 sec"
            || FormatDuration(61) != "1 min 1 sec"
            || FormatDuration(MaximumDisplayedEtaSeconds) != "5 min 0 sec"
            || !ShouldExpandDetails(false, true, false)
            || ShouldExpandDetails(false, true, true)
            || ShouldExpandDetails(true, true, false)
            || !ShouldCollapseDetails(true, false)
            || ShouldCollapseDetails(true, true)
            || ShouldCollapseDetails(false, false)
        )
        {
            return 1;
        }

        if (IntPtr.Size == 4)
        {
            IntPtr parsedPointer;
            if (
                !TryParsePointer("-2147483648", out parsedPointer)
                || parsedPointer.ToInt32() != int.MinValue
                || !TryParsePointer("4294967295", out parsedPointer)
                || parsedPointer.ToInt32() != -1
                || TryParsePointer("-2147483649", out parsedPointer)
                || TryParsePointer("4294967296", out parsedPointer)
            )
            {
                return 1;
            }
        }

        return 0;
    }
}
