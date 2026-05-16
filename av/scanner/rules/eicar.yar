rule EICAR_Test {
    meta:
        description = "EICAR antivirus test file"
        author = "Nextcloud AV"
    strings:
        $eicar = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE"
    condition:
        $eicar
}
