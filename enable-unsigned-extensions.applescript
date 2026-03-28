-- Enable "Allow Unsigned Extensions" in Safari Developer settings
-- Runs automatically when Safari launches

on run
    tell application "Safari"
        activate
    end tell
    
    delay 1
    
    tell application "System Events"
        tell process "Safari"
            -- Open Safari Settings
            keystroke "," using command down
            delay 1
            
            -- Click "Developer" tab (מפתחים)
            set tabGroup to tab group 1 of window 1
            try
                click radio button "מפתחים" of tabGroup
            on error
                try
                    click radio button "Developer" of tabGroup
                on error
                    -- Try clicking by position if name doesn't match
                    click radio button 2 of tabGroup
                end try
            end try
            delay 0.5
            
            -- Find and enable "Allow Unsigned Extensions" checkbox
            set foundCheckbox to false
            repeat with cb in (every checkbox of group 1 of group 1 of tabGroup)
                set cbName to name of cb
                if cbName contains "unsigned" or cbName contains "לא חתומות" then
                    if value of cb is 0 then
                        click cb
                        delay 1
                        -- Handle password dialog
                        try
                            -- Click "Allow" or "אישור" in the auth dialog
                            repeat 10 times
                                if exists sheet 1 of window 1 then
                                    -- Password dialog appeared - user types password
                                    exit repeat
                                end if
                                delay 0.5
                            end repeat
                        end try
                    end if
                    set foundCheckbox to true
                    exit repeat
                end if
            end repeat
            
            -- Close Settings
            delay 0.5
            keystroke "w" using command down
        end tell
    end tell
end run
