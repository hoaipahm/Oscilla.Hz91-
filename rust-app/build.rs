use std::env;
use std::fs;
use std::path::PathBuf;

fn push_u16(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn push_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn align8(buf: &mut Vec<u8>) {
    while buf.len() % 8 != 0 {
        buf.push(0);
    }
}

fn main() {
    println!("cargo:rerun-if-changed=../app.ico");
    println!("cargo:rerun-if-changed=assets/mg-window.exe");

    let ico = fs::read("../app.ico").expect("Failed to read ../app.ico");
    if ico.len() < 6 {
        return;
    }
    let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
    if count == 0 {
        return;
    }

    let mut icons: Vec<&[u8]> = Vec::new();
    let mut grp = Vec::new();
    grp.extend_from_slice(&ico[0..6]);

    for i in 0..count {
        let off = 6 + i * 16;
        if off + 16 > ico.len() {
            break;
        }
        let entry = &ico[off..off + 16];
        let size = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as usize;
        let data_off = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
        if data_off + size > ico.len() {
            continue;
        }
        let id = (icons.len() + 1) as u16;
        icons.push(&ico[data_off..data_off + size]);
        grp.extend_from_slice(&entry[0..12]);
        push_u16(&mut grp, id);
    }

    let n = icons.len();
    if n == 0 {
        return;
    }

    // Build .rsrc raw data:
    // Root directory (16B) + 2 entries (RT_ICON=3, RT_GROUP_ICON=14) (16B) = 32B (0..32)
    // Type 3 directory (16B) + n entries (8B * n)
    // Type 14 directory (16B) + 1 entry (8B)
    // Language directories: (n + 1) * (16B + 8B) = (n + 1) * 24B
    // Data entries: (n + 1) * 16B
    let mut rsrc = Vec::new();

    let off_root = 0u32;
    let off_type3_dir = 32u32;
    let off_type14_dir = off_type3_dir + 16 + (n as u32) * 8;
    let off_lang_dirs = off_type14_dir + 24;
    let off_data_entries = off_lang_dirs + ((n as u32) + 1) * 24;

    // Root dir: 2 ID entries (RT_ICON = 3, RT_GROUP_ICON = 14)
    push_u32(&mut rsrc, 0);
    push_u32(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, 2);
    // Entry 1: RT_ICON (3)
    push_u32(&mut rsrc, 3);
    push_u32(&mut rsrc, 0x80000000 | off_type3_dir);
    // Entry 2: RT_GROUP_ICON (14)
    push_u32(&mut rsrc, 14);
    push_u32(&mut rsrc, 0x80000000 | off_type14_dir);
    assert_eq!(rsrc.len() as u32, off_type3_dir);

    // Type 3 (RT_ICON) dir: n ID entries
    push_u32(&mut rsrc, 0);
    push_u32(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, n as u16);
    for i in 0..n {
        let lang_dir_off = off_lang_dirs + (i as u32) * 24;
        push_u32(&mut rsrc, (i + 1) as u32);
        push_u32(&mut rsrc, 0x80000000 | lang_dir_off);
    }
    assert_eq!(rsrc.len() as u32, off_type14_dir);

    // Type 14 (RT_GROUP_ICON) dir: 1 ID entry (ID = 1)
    push_u32(&mut rsrc, 0);
    push_u32(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, 0);
    push_u16(&mut rsrc, 1);
    let grp_lang_dir_off = off_lang_dirs + (n as u32) * 24;
    push_u32(&mut rsrc, 1);
    push_u32(&mut rsrc, 0x80000000 | grp_lang_dir_off);
    assert_eq!(rsrc.len() as u32, off_lang_dirs);

    // Language dirs for each icon + group icon (lang = 0x0409)
    for i in 0..=n {
        let data_entry_off = off_data_entries + (i as u32) * 16;
        push_u32(&mut rsrc, 0);
        push_u32(&mut rsrc, 0);
        push_u16(&mut rsrc, 0);
        push_u16(&mut rsrc, 0);
        push_u16(&mut rsrc, 0);
        push_u16(&mut rsrc, 1);
        push_u32(&mut rsrc, 0x0409);
        push_u32(&mut rsrc, data_entry_off);
    }
    assert_eq!(rsrc.len() as u32, off_data_entries);

    // Reserve space for (n + 1) IMAGE_RESOURCE_DATA_ENTRY (16 bytes each)
    let mut payload_offsets = Vec::new();
    let mut payload_sizes = Vec::new();
    let mut payloads = Vec::new();
    let base_payload_off = off_data_entries + ((n as u32) + 1) * 16;

    for icon in &icons {
        align8(&mut payloads);
        payload_offsets.push(base_payload_off + (payloads.len() as u32));
        payload_sizes.push(icon.len() as u32);
        payloads.extend_from_slice(icon);
    }
    align8(&mut payloads);
    payload_offsets.push(base_payload_off + (payloads.len() as u32));
    payload_sizes.push(grp.len() as u32);
    payloads.extend_from_slice(&grp);
    align8(&mut payloads);

    let mut relocs = Vec::new();
    for i in 0..=n {
        let entry_pos = rsrc.len() as u32;
        relocs.push(entry_pos); // OffsetToData needs IMAGE_REL_AMD64_ADDR32NB (type 3)
        push_u32(&mut rsrc, payload_offsets[i]);
        push_u32(&mut rsrc, payload_sizes[i]);
        push_u32(&mut rsrc, 0); // CodePage
        push_u32(&mut rsrc, 0); // Reserved
    }
    let _ = off_root;
    rsrc.extend_from_slice(&payloads);

    // Assemble COFF .o file (x86_64)
    let mut coff = Vec::new();
    let raw_data_ptr = 60u32;
    let raw_data_size = rsrc.len() as u32;
    let reloc_ptr = raw_data_ptr + raw_data_size;
    let n_relocs = relocs.len() as u16;
    let symtab_ptr = reloc_ptr + (n_relocs as u32) * 10;

    // 20-byte COFF Header
    push_u16(&mut coff, 0x8664); // IMAGE_FILE_MACHINE_AMD64
    push_u16(&mut coff, 1); // NumberOfSections
    push_u32(&mut coff, 0); // TimeDateStamp
    push_u32(&mut coff, symtab_ptr); // PointerToSymbolTable
    push_u32(&mut coff, 1); // NumberOfSymbols
    push_u16(&mut coff, 0); // SizeOfOptionalHeader
    push_u16(&mut coff, 0); // Characteristics

    // 40-byte Section Header (.rsrc)
    coff.extend_from_slice(b".rsrc\0\0\0");
    push_u32(&mut coff, 0); // VirtualSize
    push_u32(&mut coff, 0); // VirtualAddress
    push_u32(&mut coff, raw_data_size);
    push_u32(&mut coff, raw_data_ptr);
    push_u32(&mut coff, reloc_ptr);
    push_u32(&mut coff, 0); // PointerToLinenumbers
    push_u16(&mut coff, n_relocs);
    push_u16(&mut coff, 0); // NumberOfLinenumbers
    push_u32(&mut coff, 0x40300040); // INITIALIZED_DATA | MEM_READ | ALIGN_4BYTES

    // Section data
    coff.extend_from_slice(&rsrc);

    // Relocations (10 bytes each)
    for rva_off in relocs {
        push_u32(&mut coff, rva_off); // VirtualAddress
        push_u32(&mut coff, 0); // SymbolTableIndex (0 = .rsrc)
        push_u16(&mut coff, 0x0003); // IMAGE_REL_AMD64_ADDR32NB
    }

    // Symbol table: 1 entry (18 bytes) + 4-byte empty string table
    coff.extend_from_slice(b".rsrc\0\0\0");
    push_u32(&mut coff, 0); // Value
    push_u16(&mut coff, 1); // SectionNumber = 1
    push_u16(&mut coff, 0); // Type
    coff.push(3); // StorageClass = IMAGE_SYM_CLASS_STATIC
    coff.push(0); // NumberOfAuxSymbols
    push_u32(&mut coff, 4); // String table size = 4

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let obj_path = out_dir.join("icon.o");
    fs::write(&obj_path, &coff).expect("Failed to write icon.o");
    println!("cargo:rustc-link-arg={}", obj_path.display());
}
