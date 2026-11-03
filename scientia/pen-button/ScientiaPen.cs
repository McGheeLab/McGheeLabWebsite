// Scientia In Situ — the pen's button (V3.949). Assigned in Windows Settings → Pen & Windows Ink → Pen shortcut
// button → Launch a classic app, it tells the app on this computer that the button was pressed; the app switches to
// the pen, or from the pen to the other mode. Built by the installer with the C# compiler every Windows ships:
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:ScientiaPen.exe ScientiaPen.cs
using System;
using System.Net;
class ScientiaPen {
    static void Main(string[] args) {
        try {
            var port = Environment.GetEnvironmentVariable("SIS_PORT"); if (string.IsNullOrEmpty(port)) port = "8766";
            var c = new WebClient(); c.Headers["User-Agent"] = "ScientiaPen";
            c.DownloadString("http://127.0.0.1:" + port + "/api/pen-button?press=1");
        } catch (Exception) { }
    }
}
