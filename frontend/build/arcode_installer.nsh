; Custom NSIS script for Arcode installation detail output and progress text.

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  Var ArcodeInstallProgressLastText

  !macro Arcode_PrintInstallDetail MSG
    SetDetailsPrint both
    SetDetailsView show
    DetailPrint "${MSG}"
  !macroend
!endif

ShowInstDetails show
ShowUninstDetails show

!macro preInit
  SetDetailsPrint both
!macroend

!macro customInit
  SetDetailsPrint both
  SetDetailsView show
  DetailPrint "===== Installing Arcode ====="
  DetailPrint "Preparing installation..."
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW Arcode_InstFiles_Show
  !macroend

  Function Arcode_InstFiles_Show
    StrCpy $ArcodeInstallProgressLastText ""
    !insertmacro Arcode_PrintInstallDetail "Installer progress monitoring started."
    !insertmacro Arcode_PrintInstallDetail "Preparing destination and installing Arcode files..."
    Call Arcode_InstFiles_UpdateProgressText
    nsDialogs::CreateTimer Arcode_InstFiles_UpdateProgressText 500
  FunctionEnd

  Function Arcode_InstFiles_UpdateProgressText
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1004
    GetDlgItem $2 $0 1006
    ${If} $1 == 0
    ${OrIf} $2 == 0
    ${OrIf} $0 == 0
      Return
    ${EndIf}

    SendMessage $1 0x0408 0 0 $3
    SendMessage $1 0x0407 0 0 $4
    SendMessage $1 0x0407 1 0 $5
    IntOp $8 $4 - $5
    ${If} $8 <= 0
      Return
    ${EndIf}

    IntOp $6 $3 - $5
    IntOp $6 $6 * 100
    IntOp $6 $6 / $8
    ${If} $6 < 10
      StrCpy $6 10
    ${ElseIf} $6 > 99
      StrCpy $6 99
    ${EndIf}

    StrCpy $7 "[$6%] Installing Arcode files..."
    ${If} $7 != $ArcodeInstallProgressLastText
      StrCpy $ArcodeInstallProgressLastText $7
      SendMessage $2 0x000C 0 "STR:$7"
    ${EndIf}
  FunctionEnd

  Function Arcode_InstFiles_CompleteProgressText
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1006
    ${If} $0 == 0
    ${OrIf} $1 == 0
      Return
    ${EndIf}
    SendMessage $1 0x000C 0 "STR:[100%] Installation complete."
  FunctionEnd

  !macro customFiles_x64
    !insertmacro Arcode_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro Arcode_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  !macro customFiles_ia32
    !insertmacro Arcode_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro Arcode_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  !macro customFiles_arm64
    !insertmacro Arcode_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro Arcode_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  !macro registerFileAssociations
    !insertmacro Arcode_PrintInstallDetail "[90%] Creating shortcuts and registry entries..."
  !macroend

  !macro customInstall
    nsDialogs::KillTimer Arcode_InstFiles_UpdateProgressText
    Call Arcode_InstFiles_CompleteProgressText
    !insertmacro Arcode_PrintInstallDetail "[100%] Installation complete."
  !macroend
!endif

!macro customUnInstall
  SetDetailsPrint both
  SetDetailsView show
  DetailPrint "===== Uninstalling Arcode ====="
!macroend
