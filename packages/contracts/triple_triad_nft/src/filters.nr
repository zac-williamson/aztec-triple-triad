use aztec::note::HintedNote;
use aztec::protocol::constants::MAX_NOTE_HASH_READ_REQUESTS_PER_CALL;
use field_note::FieldNote;

pub fn filter_by_token_ids(
    notes: [Option<HintedNote<FieldNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL],
    token_ids: [Field; 5],
) -> [Option<HintedNote<FieldNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL] {
    let mut selected = [Option::none(); MAX_NOTE_HASH_READ_REQUESTS_PER_CALL];
    let mut found = [false; 5];

    for i in 0..notes.len() {
        if notes[i].is_some() {
            let note_value = notes[i].unwrap_unchecked().note.value;
            for j in 0..5 {
                if !found[j] & (note_value == token_ids[j]) {
                    selected[i] = notes[i];
                    found[j] = true;
                }
            }
        }
    }
    selected
}
