# Windows caches the Start menu icon and the pinned taskbar icon against the
# previous icon file. An upgrade keeps those shortcuts, so they would keep
# showing the old artwork. A new file each release makes them load this one.
# The shortcut id matches windowsAppUserModelId in the packaged app.

!macro refreshShellShortcut link icon
  ${if} ${FileExists} "${link}"
    CreateShortCut "${link}" "$appExe" "" "${icon}" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "${link}" "${APP_ID}"
    StrCpy $R7 "${link}"
    System::Call 'Shell32::SHChangeNotify(i 0x2000, i 0x1005, w R7, p 0)'
  ${endIf}
!macroend

!macro customInstall
  StrCpy $R2 0
  nextOldIcon:
    IntOp $R2 $R2 + 1
    IntCmp $R2 20 noOldIcons
    ClearErrors
    FindFirst $R0 $R1 "$INSTDIR\BotCamp-*.ico"
    IfErrors noOldIcons
    FindClose $R0
    Delete "$INSTDIR\$R1"
    IfErrors noOldIcons
    Goto nextOldIcon
  noOldIcons:
    ClearErrors

  SetOutPath "$INSTDIR"
  File "/oname=BotCamp-${VERSION}.ico" "${BUILD_RESOURCES_DIR}\icon.ico"
  StrCpy $R9 "$INSTDIR\BotCamp-${VERSION}.ico"

  !insertmacro refreshShellShortcut "$newStartMenuLink" "$R9"
  !insertmacro refreshShellShortcut "$newDesktopLink" "$R9"
  !insertmacro refreshShellShortcut "$QUICKLAUNCH\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk" "$R9"

  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
