; Custom NSIS script for richer installation detail output and progress text.

; electron-builder prepends this custom include before its own MUI2 include.
; Load MUI2 here so MUI_HEADER_TEXT is defined when the functions below are parsed.
!ifndef MUI_INCLUDED
  !include "MUI2.nsh"
!endif

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  !define ARCRHO_PREFERRED_INSTALL_COMPUTER "NE7SASWPN02"
  !define ARCRHO_PREFERRED_INSTALL_DRIVE "E:"

  ; electron-builder expands this hook after common.nsh, whose default is
  ; "nevershow". Keep the log collapsed while exposing the native Show details
  ; control on the assisted installer page.
  !macro customHeader
    ShowInstDetails hide
  !macroend

  Var ArcRhoInstallExcelAddIn
  Var ArcRhoInstallExcelAddInCheckbox
  Var ArcRhoLaunchDataEngine
  Var ArcRhoLaunchDataEngineCheckbox
  Var ArcRhoServerRoot
  Var ArcRhoServerRootDetected
  Var ArcRhoServerRootIsLocal
  Var ArcRhoDataEngineInstalled
  Var ArcRhoServerDriveDropList
  Var ArcRhoExcelAddInPath
  Var ArcRhoPreferredInstallDirectory
  Var ArcRhoInstallLocationIsOwned

  !macro ArcRho_PrintInstallDetail MSG
    ; Keep action-level output in the details list so it cannot replace the
    ; bar-derived percentage and time estimate in the status caption.
    SetDetailsPrint listonly
    DetailPrint "${MSG}"
  !macroend
!endif

ShowUninstDetails show

!macro preInit
  SetDetailsPrint both
!macroend

!macro customInit
  SetDetailsPrint both
  ; electron-builder includes this file at the top of its generated script, ahead
  ; of both multiUser.nsh and its own !addplugindir lines, so the functions below
  ; can use neither its install-mode variables nor the StdUtils plugin. This macro
  ; is expanded inside .onInit after initMultiUser, where both are available, so
  ; decide there whether something already owns the install location.
  StrCpy $ArcRhoInstallLocationIsOwned ""
  !ifndef INSTALL_MODE_PER_ALL_USERS
    ${If} $perUserInstallationFolder != ""
      StrCpy $ArcRhoInstallLocationIsOwned "1"
    ${EndIf}
  !endif
  !ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED
    ${If} $perMachineInstallationFolder != ""
      StrCpy $ArcRhoInstallLocationIsOwned "1"
    ${EndIf}
  !endif
  ${StdUtils.GetParameter} $0 "D" ""
  ${If} $0 != ""
    StrCpy $ArcRhoInstallLocationIsOwned "1"
  ${EndIf}
  Call ArcRho_PreparePreferredInstallDirectory
  StrCpy $ArcRhoInstallExcelAddIn "1"
  Call ArcRho_DetectServerRoot
  ; Launching the data engine only makes sense on the computer that hosts the
  ; ArcRho Server folder; a network-drive root means the services run elsewhere.
  StrCpy $ArcRhoLaunchDataEngine "0"
  ${If} $ArcRhoServerRootIsLocal == "1"
  ${AndIf} $ArcRhoDataEngineInstalled == "1"
    StrCpy $ArcRhoLaunchDataEngine "1"
  ${EndIf}
  ${IfNot} ${Silent}
    ; Extract the observer before the InstFiles worker starts. It only reads
    ; the native bar and never executes installer script on the UI thread.
    InitPluginsDir
    File /oname=$PLUGINSDIR\ArcRhoInstallerProgress.exe "${PROJECT_DIR}\build\generated\ArcRhoInstallerProgress.exe"
  ${EndIf}
  DetailPrint "===== Installing ArcRho ====="
  DetailPrint "Preparing installation..."
!macroend

; This hook is inserted immediately before MUI_PAGE_INSTFILES.
!ifndef BUILD_UNINSTALLER
  !macro ArcRho_CheckServerRoot DRIVE
    ${If} $ArcRhoServerRoot == ""
    ${AndIf} ${FileExists} "${DRIVE}\ArcRho Server\*.*"
      StrCpy $ArcRhoServerRoot "${DRIVE}\ArcRho Server"
      StrCpy $ArcRhoServerRootDetected "1"
    ${EndIf}
  !macroend

  !macro ArcRho_AddDriveOption DRIVE
    ${If} ${FileExists} "${DRIVE}\*.*"
      ${NSD_CB_AddString} $ArcRhoServerDriveDropList "${DRIVE}"
      ${If} $ArcRhoServerRoot == ""
        StrCpy $ArcRhoServerRoot "${DRIVE}\ArcRho Server"
        ${NSD_CB_SelectString} $ArcRhoServerDriveDropList "${DRIVE}"
      ${EndIf}
    ${EndIf}
  !macroend

  !macro customWelcomePage
    Page custom ArcRho_ExcelAddInOptions_Show ArcRho_ExcelAddInOptions_Leave
  !macroend

  ; The build patcher expands this hidden page immediately before
  ; electron-builder's directory page, after install-mode selection.
  !macro customPageBeforeChangeDir
    Page custom ArcRho_InstallDirectory_Pre
  !macroend

  Function ArcRho_PreparePreferredInstallDirectory
    StrCpy $ArcRhoPreferredInstallDirectory ""

    ; Existing installations and explicit /D paths own their install location.
    ${If} $ArcRhoInstallLocationIsOwned == "1"
      Return
    ${EndIf}

    System::Call 'kernel32::GetComputerName(t.r0, *i ${NSIS_MAX_STRLEN}) i.r1'
    ${If} $1 == 0
    ${OrIf} $0 != "${ARCRHO_PREFERRED_INSTALL_COMPUTER}"
      Return
    ${EndIf}

    System::Call 'advapi32::GetUserName(t.r1, *i ${NSIS_MAX_STRLEN}) i.r2'
    ${If} $2 == 0
    ${OrIf} $1 == ""
      DetailPrint "Windows login name could not be detected; keeping the standard install location."
      Return
    ${EndIf}

    StrCpy $ArcRhoPreferredInstallDirectory "${ARCRHO_PREFERRED_INSTALL_DRIVE}\$1\${APP_FILENAME}"
    ClearErrors
    CreateDirectory "$ArcRhoPreferredInstallDirectory"
    ${If} ${Errors}
      DetailPrint "Could not create $ArcRhoPreferredInstallDirectory; keeping the standard install location."
      StrCpy $ArcRhoPreferredInstallDirectory ""
      Return
    ${EndIf}
    ${IfNot} ${FileExists} "$ArcRhoPreferredInstallDirectory\*.*"
      DetailPrint "Could not verify $ArcRhoPreferredInstallDirectory; keeping the standard install location."
      StrCpy $ArcRhoPreferredInstallDirectory ""
      Return
    ${EndIf}

    StrCpy $INSTDIR $ArcRhoPreferredInstallDirectory
    DetailPrint "Default install location: $INSTDIR"
  FunctionEnd

  Function ArcRho_InstallDirectory_Pre
    ; The mode-selection page rewrites $INSTDIR, so restore the prepared default
    ; only when this fresh install successfully created its preferred folder.
    ${If} $ArcRhoPreferredInstallDirectory != ""
      StrCpy $INSTDIR $ArcRhoPreferredInstallDirectory
    ${EndIf}
    Abort
  FunctionEnd

  Function ArcRho_DetectServerRoot
    StrCpy $ArcRhoServerRoot ""
    StrCpy $ArcRhoServerRootDetected "0"
    Call ArcRho_DetectConfiguredServerRoot
    ${If} $ArcRhoServerRoot == ""
      !insertmacro ArcRho_CheckServerRoot "C:"
      !insertmacro ArcRho_CheckServerRoot "D:"
      !insertmacro ArcRho_CheckServerRoot "E:"
      !insertmacro ArcRho_CheckServerRoot "F:"
      !insertmacro ArcRho_CheckServerRoot "G:"
      !insertmacro ArcRho_CheckServerRoot "H:"
      !insertmacro ArcRho_CheckServerRoot "I:"
      !insertmacro ArcRho_CheckServerRoot "J:"
      !insertmacro ArcRho_CheckServerRoot "K:"
      !insertmacro ArcRho_CheckServerRoot "L:"
      !insertmacro ArcRho_CheckServerRoot "M:"
      !insertmacro ArcRho_CheckServerRoot "N:"
      !insertmacro ArcRho_CheckServerRoot "O:"
      !insertmacro ArcRho_CheckServerRoot "P:"
      !insertmacro ArcRho_CheckServerRoot "Q:"
      !insertmacro ArcRho_CheckServerRoot "R:"
      !insertmacro ArcRho_CheckServerRoot "S:"
      !insertmacro ArcRho_CheckServerRoot "T:"
      !insertmacro ArcRho_CheckServerRoot "U:"
      !insertmacro ArcRho_CheckServerRoot "V:"
      !insertmacro ArcRho_CheckServerRoot "W:"
      !insertmacro ArcRho_CheckServerRoot "X:"
      !insertmacro ArcRho_CheckServerRoot "Y:"
      !insertmacro ArcRho_CheckServerRoot "Z:"
    ${EndIf}
    Call ArcRho_DetectServerRootIsLocal
    Call ArcRho_DetectDataEngineInstalled
  FunctionEnd

  Function ArcRho_DetectConfiguredServerRoot
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=detect_arcrho_server_root.ps1 "${PROJECT_DIR}\build\installer\detect_arcrho_server_root.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\detect_arcrho_server_root.ps1"'
    Pop $0
    Pop $1
    ${If} $0 == 0
    ${AndIf} $1 != ""
      StrCpy $ArcRhoServerRoot $1
      StrCpy $ArcRhoServerRootDetected "1"
      DetailPrint "Configured ArcRho Server folder: $ArcRhoServerRoot"
    ${EndIf}
  FunctionEnd

  Function ArcRho_DetectServerRootIsLocal
    StrCpy $ArcRhoServerRootIsLocal "0"
    ${If} $ArcRhoServerRootDetected == "1"
      ; DRIVE_FIXED (3) means the detected root lives on this computer's own
      ; disk; mapped network drives report DRIVE_REMOTE (4).
      StrCpy $0 $ArcRhoServerRoot 3
      System::Call 'kernel32::GetDriveTypeW(w r0) i .r1'
      ${If} $1 == 3
        StrCpy $ArcRhoServerRootIsLocal "1"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function ArcRho_DetectDataEngineInstalled
    StrCpy $ArcRhoDataEngineInstalled "0"
    ${If} $ArcRhoServerRoot != ""
      ${If} ${FileExists} "$ArcRhoServerRoot\apps\ArcRho Launcher\ArcRho Launcher.exe"
      ${OrIf} ${FileExists} "$ArcRhoServerRoot\apps\ADAS Shell\ADAS Shell.exe"
        StrCpy $ArcRhoDataEngineInstalled "1"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function ArcRho_SetExcelAddInPath
    ${If} $ArcRhoServerRoot != ""
      StrCpy $ArcRhoExcelAddInPath "$ArcRhoServerRoot\Excel Add-ins\ArcRho.xlam"
    ${Else}
      StrCpy $ArcRhoExcelAddInPath ""
    ${EndIf}
  FunctionEnd

  Function ArcRho_ExcelAddInOptions_Show
    !insertmacro MUI_HEADER_TEXT "Setup Options" "Choose the optional ArcRho setup steps."

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 22u "ArcRho can register the Excel add-in and start existing data engine components during setup."
    Pop $1

    ${If} $ArcRhoServerRootDetected == "1"
      ${NSD_CreateLabel} 0 30u 100% 22u "Detected ArcRho Server folder: $ArcRhoServerRoot"
      Pop $1
      ${If} $ArcRhoServerRootIsLocal != "1"
        ${NSD_CreateLabel} 0 52u 100% 22u "This ArcRho Server folder is on a network drive, so the data engine components run on the computer that hosts it and cannot be launched from here."
        Pop $1
      ${ElseIf} $ArcRhoDataEngineInstalled != "1"
        ${NSD_CreateLabel} 0 52u 100% 22u "No server components are installed in this workspace. Use ArcRho Server Components Setup on the host PC."
        Pop $1
      ${EndIf}
    ${Else}
      ${NSD_CreateLabel} 0 30u 100% 22u "Select the drive where ArcRho Server should be located:"
      Pop $1
      ${NSD_CreateDropList} 0 54u 80u 80u ""
      Pop $ArcRhoServerDriveDropList
      StrCpy $ArcRhoServerRoot ""
      !insertmacro ArcRho_AddDriveOption "C:"
      !insertmacro ArcRho_AddDriveOption "D:"
      !insertmacro ArcRho_AddDriveOption "E:"
      !insertmacro ArcRho_AddDriveOption "F:"
      !insertmacro ArcRho_AddDriveOption "G:"
      !insertmacro ArcRho_AddDriveOption "H:"
      !insertmacro ArcRho_AddDriveOption "I:"
      !insertmacro ArcRho_AddDriveOption "J:"
      !insertmacro ArcRho_AddDriveOption "K:"
      !insertmacro ArcRho_AddDriveOption "L:"
      !insertmacro ArcRho_AddDriveOption "M:"
      !insertmacro ArcRho_AddDriveOption "N:"
      !insertmacro ArcRho_AddDriveOption "O:"
      !insertmacro ArcRho_AddDriveOption "P:"
      !insertmacro ArcRho_AddDriveOption "Q:"
      !insertmacro ArcRho_AddDriveOption "R:"
      !insertmacro ArcRho_AddDriveOption "S:"
      !insertmacro ArcRho_AddDriveOption "T:"
      !insertmacro ArcRho_AddDriveOption "U:"
      !insertmacro ArcRho_AddDriveOption "V:"
      !insertmacro ArcRho_AddDriveOption "W:"
      !insertmacro ArcRho_AddDriveOption "X:"
      !insertmacro ArcRho_AddDriveOption "Y:"
      !insertmacro ArcRho_AddDriveOption "Z:"
      ${NSD_CreateLabel} 0 80u 100% 22u "Excel add-in path will use <drive>\ArcRho Server\Excel Add-ins\ArcRho.xlam."
      Pop $1
    ${EndIf}

    ${NSD_CreateLabel} 0 100u 100% 18u "Server binaries are delivered separately and are never installed or removed by ArcRho Desktop Setup."
    Pop $1

    ${NSD_CreateCheckbox} 0 126u 48% 26u "Install ArcRho Excel add-in"
    Pop $ArcRhoInstallExcelAddInCheckbox
    ${If} $ArcRhoInstallExcelAddIn == "1"
      ${NSD_Check} $ArcRhoInstallExcelAddInCheckbox
    ${EndIf}

    ${NSD_CreateCheckbox} 50% 126u 50% 26u "Launch ArcRho data engine at login"
    Pop $ArcRhoLaunchDataEngineCheckbox
    ${If} $ArcRhoServerRootIsLocal == "1"
    ${AndIf} $ArcRhoDataEngineInstalled == "1"
      ${If} $ArcRhoLaunchDataEngine == "1"
        ${NSD_Check} $ArcRhoLaunchDataEngineCheckbox
      ${EndIf}
    ${Else}
      EnableWindow $ArcRhoLaunchDataEngineCheckbox 0
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function ArcRho_ExcelAddInOptions_Leave
    ${NSD_GetState} $ArcRhoInstallExcelAddInCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $ArcRhoInstallExcelAddIn "1"
    ${Else}
      StrCpy $ArcRhoInstallExcelAddIn "0"
    ${EndIf}

    StrCpy $ArcRhoLaunchDataEngine "0"
    ${If} $ArcRhoServerRootIsLocal == "1"
    ${AndIf} $ArcRhoDataEngineInstalled == "1"
      ${NSD_GetState} $ArcRhoLaunchDataEngineCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $ArcRhoLaunchDataEngine "1"
      ${EndIf}
    ${EndIf}

    ${If} $ArcRhoServerRootDetected != "1"
      ${NSD_GetText} $ArcRhoServerDriveDropList $0
      ${If} $0 != ""
        StrCpy $ArcRhoServerRoot "$0\ArcRho Server"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW ArcRho_InstFiles_Show
  !macroend

  Function ArcRho_InstFiles_Show
    !insertmacro MUI_HEADER_TEXT "" "$(MUI_TEXT_INSTALLING_SUBTITLE)"
    !insertmacro ArcRho_PrintInstallDetail "Installer progress monitoring started."
    !insertmacro ArcRho_PrintInstallDetail "Preparing destination and installing ArcRho files..."
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1004
    GetDlgItem $2 $0 1006
    ; Standard NSIS InstFiles control IDs: details list and Show details button.
    GetDlgItem $4 $0 1016
    GetDlgItem $5 $0 1027
    ${If} $1 == 0
    ${OrIf} $2 == 0
    ${OrIf} $4 == 0
    ${OrIf} $5 == 0
    ${OrIf} $0 == 0
      Return
    ${EndIf}

    SendMessage $2 0x000C 0 "STR:0% complete - Estimating time left..."
    System::Call "kernel32::GetCurrentProcessId() i.r3"
    ClearErrors
    Exec '"$PLUGINSDIR\ArcRhoInstallerProgress.exe" "$HWNDPARENT" "$0" "$1" "$2" "$4" "$5" "$3"'
    ${If} ${Errors}
      !insertmacro ArcRho_PrintInstallDetail "Progress text observer could not be started."
    ${EndIf}
  FunctionEnd

  Function ArcRho_InstFiles_CompleteProgressText
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1006
    ${If} $0 == 0
    ${OrIf} $1 == 0
      Return
    ${EndIf}
    SendMessage $1 0x000C 0 "STR:100% complete - Installation complete."
  FunctionEnd

  !macro ArcRho_PrintCoreFileDetails
    !insertmacro ArcRho_PrintInstallDetail "Core application files extracted."
    !insertmacro ArcRho_PrintInstallDetail "Writing installer metadata..."
  !macroend

  ; electron-builder runs the matching hook after the embedded package is extracted.
  !macro customFiles_x64
    !insertmacro ArcRho_PrintCoreFileDetails
  !macroend

  !macro customFiles_ia32
    !insertmacro ArcRho_PrintCoreFileDetails
  !macroend

  !macro customFiles_arm64
    !insertmacro ArcRho_PrintCoreFileDetails
  !macroend

  ; Optional no-op hook used only to surface an action detail before final completion.
  !macro registerFileAssociations
    !insertmacro ArcRho_PrintInstallDetail "Creating shortcuts and registry entries..."
  !macroend

  Function ArcRho_InstallExcelAddIn
    InitPluginsDir
    File /oname=$PLUGINSDIR\install_arcrho_excel_addin.ps1 "${PROJECT_DIR}\build\installer\install_arcrho_excel_addin.ps1"
    Call ArcRho_SetExcelAddInPath

    ${If} $ArcRhoExcelAddInPath == ""
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Excel add-in installation skipped because no ArcRho Server root was selected or detected."
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "ArcRho was installed, but the Excel add-in could not be installed automatically because no ArcRho Server root was selected or detected."
      ${EndIf}
      Return
    ${EndIf}

    !insertmacro ArcRho_PrintInstallDetail "Installing ArcRho Excel add-in..."
    !insertmacro ArcRho_PrintInstallDetail "Excel add-in path: $ArcRhoExcelAddInPath"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -STA -File "$PLUGINSDIR\install_arcrho_excel_addin.ps1" -AddInPath "$ArcRhoExcelAddInPath"'
    Pop $0
    Pop $1

    ${If} $1 != ""
      !insertmacro ArcRho_PrintInstallDetail "$1"
    ${EndIf}

    ${If} $0 == 0
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Excel add-in installed."
    ${Else}
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Excel add-in installation failed with exit code $0."
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "ArcRho was installed, but the Excel add-in could not be installed automatically. You can install it manually from $ArcRhoExcelAddInPath.$\r$\n$\r$\n$1"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function ArcRho_LaunchDataEngineComponents
    ; ArcRho Launcher owns the startup registration and service launch: it
    ; recreates its own shortcut in the user's Startup folder and then starts
    ; the orchestrator and bridge, so the installer only needs to run it.
    StrCpy $0 "$ArcRhoServerRoot\apps\ArcRho Launcher\ArcRho Launcher.exe"
    ${IfNot} ${FileExists} "$0"
      StrCpy $0 "$ArcRhoServerRoot\apps\ADAS Shell\ADAS Shell.exe"
    ${EndIf}

    ${IfNot} ${FileExists} "$0"
      !insertmacro ArcRho_PrintInstallDetail "ArcRho data engine launch skipped because no ArcRho Launcher was found under $ArcRhoServerRoot\apps."
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "ArcRho was installed, but no server components were found under $ArcRhoServerRoot\apps. Run ArcRho Server Components Setup on the PC that locally hosts this workspace."
      ${EndIf}
      Return
    ${EndIf}

    !insertmacro ArcRho_PrintInstallDetail "Starting ArcRho data engine components..."
    !insertmacro ArcRho_PrintInstallDetail "ArcRho Launcher: $0"
    ClearErrors
    Exec '"$0"'
    ${If} ${Errors}
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Launcher could not be started."
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "ArcRho was installed, but the data engine components could not be started. You can start them manually from $0."
      ${EndIf}
    ${Else}
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Launcher started; it registers itself in the Startup folder and launches the data engine services."
    ${EndIf}
  FunctionEnd

  !macro customInstall
    ${If} $ArcRhoInstallExcelAddIn == "1"
      Call ArcRho_InstallExcelAddIn
    ${Else}
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Excel add-in installation skipped."
    ${EndIf}
    ${If} $ArcRhoLaunchDataEngine == "1"
      Call ArcRho_LaunchDataEngineComponents
    ${Else}
      !insertmacro ArcRho_PrintInstallDetail "ArcRho data engine launch skipped."
    ${EndIf}
    Call ArcRho_InstFiles_CompleteProgressText
    !insertmacro ArcRho_PrintInstallDetail "Installation complete."
  !macroend
!endif

!macro customUnInstall
  SetDetailsPrint both
  SetDetailsView show
  DetailPrint "===== Uninstalling ArcRho ====="
!macroend
