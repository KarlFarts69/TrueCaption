window.DocumentEngine = {
  doctypes: [
    {
      id: 'appearance',
      label: 'Appearance',
      group: 'Administrative & representational',
      fields: [
        { id: 'dated', label: 'Dated', type: 'date' }
      ],
      // Wording taken verbatim from the filed appearances, with the role word
      // derived from the matter so caption, body and signature always agree.
      build(matter, attorney, fields) {
        const { label, lower } = ourRoleWords(matter);
        const dated = fields.dated
          ? formatLongDate(fields.dated)
          : formatLongDate(new Date().toISOString().slice(0, 10));
        return [
          { type: 'district_caption' },
          { type: 'title_underlined', text: 'APPEARANCE' },
          { type: 'plain', text: 'TO:  THE CLERK OF THE COURT' },
          { type: 'spacer', lines: 1 },
          { type: 'body', text: `Please enter the Appearance of ${(attorney.name || '').toUpperCase()} as the attorney of record for ${lower} in the above-entitled matter.` },
          { type: 'body', text: 'Please direct all future correspondence to my attention.' },
          { type: 'spacer', lines: 1 },
          // The date belongs INSIDE the signature block, above the rule, and
          // is labeled "Date:" — settled 2026-08-18 (decision 7, spec §06),
          // which rejected both the "Dated:" label and the flush-left position
          // this used to use.
          { type: 'appearance_signature', label, dated }
        ];
      }
    },
    {
      id: 'appellate_brief',
      label: 'Appellate Brief / Answer',
      // Not in build-plan §5's taxonomy table by name (only "Brief in Support
      // / Notice of Hearing" are listed under this heading) — grouped here as
      // a UI categorization call, not a legal-formatting one, since it reads
      // as a brief. Flagged in case it should be split out on sight.
      group: 'Briefs and notices',
      fields: [
        { id: 'doc_title', label: 'Document Title', type: 'text' },
        { id: 'oral_argument', label: 'Oral Argument Requested', type: 'select', options: ['Yes', 'No'] },
        { id: 'dated', label: 'Dated', type: 'date' },
        { id: 'body_text', label: 'Body', type: 'textarea' },
        { id: 'relief', label: 'Request for Relief', type: 'textarea' }
      ],
      // Circuit Court form: compound roles, both counsel blocks in the caption,
      // and the MCR countable-words line at the end.
      build(matter, attorney, fields) {
        // Document title is bold only; underlining is reserved for section
        // headings such as REQUEST FOR RELIEF, matching the reference brief.
        const blocks = [
          { type: 'appellate_caption' },
          { type: 'centered_bold', text: (fields.doc_title || 'BRIEF').toUpperCase() }
        ];
        if (fields.oral_argument === 'Yes') {
          blocks.push({ type: 'centered_bold', text: 'ORAL ARGUMENT REQUESTED' });
        }
        blocks.push({ type: 'heavy_rule' });
        blocks.push({ type: 'plain', text: formatLongDate(fields.dated || new Date().toISOString().slice(0, 10)) });
        if (fields.body_text) blocks.push({ type: 'freetext', text: fields.body_text });
        if (fields.relief) {
          blocks.push({ type: 'pagebreak' });
          blocks.push({ type: 'title_underlined', text: 'REQUEST FOR RELIEF' });
          blocks.push({ type: 'freetext', text: fields.relief });
        }
        blocks.push({ type: 'spacer', lines: 2 });
        // The brief's signature carries its own date — confirmed by the attorney
        // 2026-08-19. The cover page's date above is a separate fact; a brief
        // is signed on the day it is filed. Labeled "Date:" like every other
        // signature (decision 7).
        blocks.push({
          type: 'respectfully_submitted',
          dated: formatLongDate(fields.dated || new Date().toISOString().slice(0, 10))
        });
        // Counted across the argument text, which is what MCR 7.212 measures.
        blocks.push({ type: 'word_count', text: `${fields.body_text || ''}\n${fields.relief || ''}` });
        return blocks;
      }
    },
    {
      id: 'proof_of_service',
      label: 'Proof of Service (Standalone)',
      group: 'Administrative & representational',
      fields: [
        { id: 'documents_served', label: 'Documents Served', type: 'text', default: 'the foregoing document' },
        { id: 'service_method', label: 'Service Method', type: 'select', options: ['first-class mail', 'electronic service', 'personal service'] },
        { id: 'service_date', label: 'Service Date', type: 'date' }
      ],
      build(matter, attorney, fields) {
        return [
          { type: 'caption' },
          { type: 'title_underlined', text: 'PROOF OF SERVICE' },
          { type: 'proof_of_service_block', data: fields }
        ];
      }
    },
    {
      id: 'notice_of_hearing',
      label: 'Notice of Hearing',
      group: 'Briefs and notices',
      fields: [
        { id: 'hearing_date', label: 'Hearing Date', type: 'date' },
        { id: 'hearing_time', label: 'Hearing Time', type: 'text', default: '9:00 AM' },
        { id: 'motion_being_heard', label: 'Motion Being Heard', type: 'text' },
        { id: 'judge_courtroom', label: 'Judge / Courtroom', type: 'text' }
      ],
      build(matter, attorney, fields) {
        return [
          { type: 'caption' },
          { type: 'title_underlined', text: 'NOTICE OF HEARING' },
          // Every slot falls back to a fill-in rule. An unset field used to be
          // interpolated raw, so a document regenerated from a snapshot taken
          // before a field existed printed the literal word "undefined" into
          // the sentence.
          { type: 'paragraph', text: `PLEASE TAKE NOTICE that on ${formatDate(fields.hearing_date) || '____________'} at ${fields.hearing_time || '____________'}, or as soon thereafter as counsel may be heard, the undersigned will bring on for hearing the ${fields.motion_being_heard || 'Motion'} before the ${fields.judge_courtroom || 'Honorable Court'}.` },
          { type: 'spacer', lines: 2 },
          { type: 'signature' },
          { type: 'pagebreak' },
          { type: 'proof_of_service' }
        ];
      }
    },
    {
      id: 'generic_motion',
      label: 'Generic Motion',
      group: 'Motions',
      fields: [
        { id: 'motion_title', label: 'Motion Title', type: 'text' },
        { id: 'body_text', label: 'Motion Body', type: 'textarea' }
      ],
      build(matter, attorney, fields) {
        return [
          { type: 'caption' },
          { type: 'title_underlined', text: fields.motion_title ? fields.motion_title.toUpperCase() : 'MOTION' },
          { type: 'freetext', text: fields.body_text },
          { type: 'spacer', lines: 2 },
          { type: 'signature' },
          { type: 'pagebreak' },
          { type: 'proof_of_service' }
        ];
      }
    },
    {
      id: 'brief_shell',
      label: 'Brief / Memorandum (Shell)',
      group: 'Briefs and notices',
      fields: [
        { id: 'brief_title', label: 'Brief Title', type: 'text' }
      ],
      build(matter, attorney, fields) {
        return [
          { type: 'caption' },
          { type: 'title_underlined', text: fields.brief_title ? fields.brief_title.toUpperCase() : 'BRIEF IN SUPPORT' },
          { type: 'freetext', text: "I. INTRODUCTION\n\n[Argument goes here. Export to Word to continue authoring.]\n\nII. ARGUMENT\n\n[Argument goes here]\n\nIII. CONCLUSION\n\n[Conclusion goes here]" },
          { type: 'spacer', lines: 2 },
          { type: 'signature' },
          { type: 'pagebreak' },
          { type: 'proof_of_service' }
        ];
      }
    },
    {
      id: 'stipulation_and_order',
      label: 'Stipulation and Order of Adjournment',
      group: 'Stipulations and orders',
      fields: [
        { id: 'hearing_type', label: 'Hearing Type', type: 'text', default: 'Formal Hearing' },
        { id: 'from_datetime', label: 'Currently Set For', type: 'text',
          placeholder: 'Tuesday, September 1, 2026 at 9:40 a.m.',
          help: 'Typed exactly as it should print — day of week, date and time. Not a date picker: no formatter here can safely produce this without guessing.' },
        { id: 'reason', label: 'Reason for Adjournment', type: 'textarea' }
      ],
      // Two pages, one filing: the stipulation (district caption, dual
      // signature) then the order the judge signs (no caption, centered
      // throughout, spec §08). The FROM date is computed once and threaded
      // into both pages' clauses — the filed working file this was
      // transcribed from shows exactly what happens when it isn't: the same
      // adjournment carrying two different dates a page apart.
      build(matter, attorney, fields) {
        const from = fields.from_datetime || '____________';
        const hearingType = fields.hearing_type || 'Hearing';
        const reason = fields.reason || '____________';

        // Bar number is BRACKETED here, unlike the ordinary closing
        // signature (decision 6) — this block functions as a counsel
        // identification as much as a signature, and both the spec's own
        // specimen and the filed exhibit show it bracketed on both sides.
        const opposing = matter.opposing_counsel_person || {};
        const hasOpposing = !!(opposing.name || opposing.firm_name);
        const opposingLines = hasOpposing
          ? [
              { text: `${opposing.name || ''}${opposing.bar_number ? ` (${opposing.bar_number})` : ''}`.trim(), bold: true },
              { text: `Attorney for Plaintiff${matter.court_city ? `, ${matter.court_city}` : ''}` },
              { text: 'Prosecutor' }
            ]
          // Free-text fallback carries no bold — matches the appellate
          // caption's own counsel fallback, which never invents formatting
          // for text it can't parse into a name.
          : String(matter.opposing_counsel || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ text: l }));

        const ourRole = matter.party_label || 'Defendant';
        const ourLines = [
          { text: `${(attorney.name || '').toUpperCase()}${attorney.bar_number ? ` (${attorney.bar_number})` : ''}`.trim(), bold: true },
          { text: `Attorney for ${ourRole}` },
          ...String(attorney.firm_address || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ text: l }))
        ];

        return [
          { type: 'district_caption' },
          { type: 'title_underlined', text: 'STIPULATION AND ORDER OF ADJOURNMENT' },
          { type: 'stipulation_clause', hearingType, from, reason },
          { type: 'dual_signature',
            left: { sig: true, lines: opposingLines },
            right: { attorney, lines: ourLines } },
          { type: 'pagebreak' },
          { type: 'title_underlined', text: 'ORDER' },
          { type: 'order_session' },
          { type: 'order_clause', hearingType, from },
          { type: 'judge_signature' }
        ];
      }
    },

    // ---- Claim & delivery packet documents ---------------------------------
    // Transcribed from two filed packets. `packet` in fields carries the
    // shared intake values; `enclosures` is the derived list.
    {
      id: 'cd_transmittal',
      label: 'C&D — Transmittal Letter',
      packetOnly: true,
      fields: [],
      build(matter, attorney, fields) {
        const p = fields.packet || {};
        const encl = fields.enclosures || [];
        return [
          { type: 'letterhead' },
          { type: 'letter_date', text: formatLongDate(p.packet_date) },
          // Two recipients with a bare "and" between them — the court, then
          // the opposing party. Straight from the filed letter.
          { type: 'recipient_block', name: p.court_recipient_name, address: p.court_recipient_address },
          { type: 'plain', text: 'and' },
          { type: 'recipient_block', name: p.recipient_name, address: p.recipient_address },
          { type: 're_block', lines: [
            `Case No. ${matter.case_number && !matter.case_number_pending ? matter.case_number : '____________'}`,
            packetCaseName(matter, p)
          ] },
          { type: 'to_the_above' },
          { type: 'letter_body', text: 'With reference to the above, please find the following enclosed.' },
          // Derived: the packet's enclosures, with "and" between them.
          { type: 'enclosure_list', items: encl.map(e => e.title) },
          { type: 'letter_close', closing: 'Very truly yours,' },
          { type: 'ref_initials' }
        ];
      }
    },
    {
      id: 'cd_memorandum',
      label: 'C&D — Memorandum to Property Officer',
      packetOnly: true,
      fields: [],
      build(matter, attorney, fields) {
        const p = fields.packet || {};
        return [
          { type: 'letterhead' },
          { type: 'title_underlined', text: 'MEMORANDUM' },
          { type: 'memo_labels', rows: [
            { label: 'DATE:', value: formatLongDate(p.packet_date) },
            { label: 'TO:', value: p.memo_to || 'Property Officer' },
            { label: 'RE:', value: [
              'Claim and Delivery Motion and Complaint',
              packetCaseName(matter, p),
              `Case No. ${matter.case_number && !matter.case_number_pending ? matter.case_number : '____________'}`
            ].join('\n'), emphasizeFrom: 1 },
            // Name in caps, then the office role — as filed.
            { label: 'FROM:', value: [(attorney.name || '').toUpperCase(), attorney.firm_name].filter(Boolean).join(', ') }
          ] },
          { type: 'letter_body', text: 'Please confirm that the Department is storing the items listed in the Motion and Complaint and that they are in the same condition as when they were confiscated and placed in the property room.' },
          { type: 'item_line', text: p.item_description },
          { type: 'letter_body', text: 'Please send me a copy of the incident report made when the items were confiscated and placed into the property room.' },
          { type: 'centered_bold', text: 'DO NOT RELEASE THE ITEMS UNTIL AFTER THE COURT HEARING.' }
        ];
      }
    },
    {
      id: 'cd_answer_motion',
      label: 'C&D — Answer to Motion',
      packetOnly: true,
      fields: [],
      build(matter, attorney, fields) {
        const p = fields.packet || {};
        return [
          { type: 'district_caption' },
          { type: 'counsel_block' },
          { type: 'title_underlined', text: 'ANSWER TO MOTION' },
          { type: 'numbered_answers', items: [
            { text: 'Answering paragraph number one, Defendant denies the allegation that the Plaintiff is lawfully entitled to the described property.' },
            { text: 'Answering paragraph number two, Defendant acknowledges that the property is being held but states that it is carefully stored and properly protected, and denies the remaining allegations, leaving Plaintiff to proofs.',
              itemAfter: p.item_description },
            { text: 'Answering paragraph number three, Defendant states there is no need for immediate possession, pending judgment.' }
          ] },
          { type: 'appearance_signature', label: matter.party_label || 'Defendant',
            dated: formatLongDate(p.packet_date) }
        ];
      }
    },
    {
      id: 'cd_answer_complaint',
      label: 'C&D — Answer to Complaint',
      packetOnly: true,
      fields: [],
      build(matter, attorney, fields) {
        const p = fields.packet || {};
        // partyCaptionText never returns empty (it falls back to a bare
        // "Defendant"), so the "[DEFENDANT]" blank is chosen here on whether
        // there are defendant parties — the same as packetCaseName.
        const hasDefendant = (matter.parties || []).some(pa => pa.side === 'defendant');
        const defName = hasDefendant
          ? partyCaptionText(matter.parties || [], 'defendant', matter.caption_style).toUpperCase()
          : '[DEFENDANT]';
        return [
          { type: 'district_caption' },
          { type: 'counsel_block' },
          { type: 'title_underlined', text: 'ANSWER TO COMPLAINT' },
          { type: 'body', text: `NOW COMES Defendant, ${defName}, by and through its City Attorney ${(attorney.name || '').toUpperCase()}, and for its Answer to the Complaint filed states as follows:` },
          { type: 'numbered_answers', items: [
            { text: 'Answering paragraph number one, Defendant denies the allegation of Plaintiff being lawfully entitled to possession in that the property was confiscated to protect the general welfare of the public, and leaves the Plaintiff to proofs of the value of the weapons.',
              itemAfter: p.item_description },
            { text: 'Answering paragraph number two, Defendant admits the allegations that each item is separate and independent.' },
            { text: 'Answering paragraph number three, Defendant admits the allegations and by way of further answer references the activities as reported in the official police department records of the incident causing the seizure and confiscation of the weapons.' }
          ] },
          { type: 'appearance_signature', label: matter.party_label || 'Defendant',
            dated: formatLongDate(p.packet_date) }
        ];
      }
    },
    {
      id: 'cd_proof_of_service',
      label: 'C&D — Proof of Service',
      packetOnly: true,
      fields: [],
      build(matter, attorney, fields) {
        const p = fields.packet || {};
        const encl = fields.enclosures || [];
        return [
          { type: 'district_caption' },
          { type: 'counsel_block' },
          { type: 'title_underlined', text: 'PROOF OF SERVICE' },
          { type: 'pos_derived',
            county: matter.court_county || '',
            // Derived from the packet, upper-cased for this document only.
            documents: encl.map(e => e.title.toUpperCase()),
            to: [p.recipient_name, p.recipient_address].filter(Boolean).join(', ').replace(/\n/g, ', '),
            on: formatLongDate(p.packet_date) },
          { type: 'appearance_signature', label: matter.party_label || 'Defendant', noBarNumber: true }
        ];
      }
    },

    // ---- Driver-license hearing request packet documents -------------------
    // Transcribed from the filed DAAD hearing request exhibit. `packet` in
    // fields carries the shared intake values, same as the C&D doctypes above.
    {
      id: 'dl_letter',
      label: 'DL — Covering Letter',
      packetOnly: true,
      fields: [],
      build(matter, attorney, fields) {
        const p = fields.packet || {};
        const c = driverLicenseClient(matter, p);
        return [
          { type: 'letterhead' },
          { type: 'letter_date', text: formatLongDate(p.packet_date) },
          { type: 'recipient_block', name: p.recipient_name, address: p.recipient_address },
          { type: 're_block', plain: true, lines: [
            c.name.toUpperCase(),
            `Driver License No. ${c.license}`,
            `Date of Birth:  ${c.dob}`
          ] },
          { type: 'salutation', text: 'Sir/Madam' },
          { type: 'letter_body', text: `I hereby request ${withArticle(p.hearing_type)} ${p.hearing_type || '____________'} hearing for the above captioned petitioner.` },
          { type: 'letter_close', closing: 'Very truly yours,' },
          { type: 'ref_initials' }
        ];
      }
    },
    {
      id: 'dl_appearance',
      label: 'DL — Appearance and Request for Hearing',
      packetOnly: true,
      fields: [],
      build(matter, attorney, fields) {
        const p = fields.packet || {};
        return [
          { type: 'daad_caption', packet: p },
          { type: 'title_underlined', text: 'APPEARANCE AND REQUEST FOR HEARING' },
          { type: 'body', text: `PLEASE ENTER my Appearance in the above-entitled cause as Attorney for and on behalf of Petitioner.  Please schedule a hearing for ${p.hearing_type || '____________'} and notify my office of the date and time of hearing requested herein.` },
          { type: 'spacer', lines: 1 },
          // Note: label carries no effect (renderAppearanceSignature derives
          // the role word from matter.party_label, not from this block) — the
          // matter's Defendant Side Label must be set to "Petitioner".
          { type: 'appearance_signature', dated: formatLongDate(p.packet_date) }
        ];
      }
    },
    {
      id: 'standalone_letter_doc',
      label: 'Letter',
      packetOnly: true,
      fields: [],
      build(matter, attorney, fields) {
        const p = fields.packet || {};
        // One letter_body block per paragraph — matches the C&D
        // transmittal's convention (main.js gives each block its own
        // indented Word Paragraph; one block holding embedded newlines
        // would not split into separate paragraphs in either engine).
        const paragraphs = String(p.letter_body || '')
          .split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
        const ccNames = String(p.cc_list || '').split('\n').map(s => s.trim()).filter(Boolean);
        return [
          { type: 'letterhead' },
          ...(p.confidential ? [{ type: 'centered_bold', text: 'Confidential Attorney-Client Communication' }] : []),
          { type: 'letter_date', text: formatLongDate(p.packet_date) },
          { type: 'recipient_block', name: p.recipient_name, address: p.recipient_address },
          ...(p.subject ? [{ type: 're_block', lines: [p.subject] }] : []),
          ...paragraphs.map(text => ({ type: 'letter_body', text })),
          { type: 'letter_close', closing: 'Very truly yours,' },
          { type: 'ref_initials' },
          ...(ccNames.length ? [{ type: 'cc_block', names: ccNames }] : [])
        ];
      }
    }
  ],

  // ---- Packets -------------------------------------------------------------
  //
  // A packet is a filing: several documents sent together on one date, into
  // one folder. Its documents each carry a ROLE, and that is what makes the
  // transmittal letter's enclosure list and the proof of service's document
  // list derived rather than typed:
  //
  //   enclosure — filed with the court AND served; appears in both lists
  //   internal  — never leaves the office (the memo to the property officer)
  //   cover     — the transmittal letter itself
  //   service   — the proof of service itself
  //
  // Wording below is transcribed from two filed claim & delivery packets. Do
  // not paraphrase it; where the two filings disagreed with a settled format
  // decision (a flush-left "Dated:", a bracketed bar number in the signature),
  // the DECISION wins — see decisions 6 and 7.
  packets: [
    {
      id: 'claim_and_delivery',
      label: 'Claim & Delivery Response',
      // One intake form for the whole filing.
      fields: [
        { id: 'packet_date', label: 'Date of Filing', type: 'date' },
        { id: 'item_description', label: 'Item(s) Seized', type: 'textarea',
          help: 'Printed verbatim, one per line, in the memo and both answers.' },
        { id: 'court_recipient_name', label: 'Court — Clerk Line', type: 'text',
          placeholder: 'CLERK OF THE 96TH DISTRICT COURT' },
        { id: 'court_recipient_address', label: 'Court — Address', type: 'textarea' },
        { id: 'recipient_name', label: 'Plaintiff — Name', type: 'text' },
        { id: 'recipient_address', label: 'Plaintiff — Address', type: 'textarea' },
        { id: 'memo_to', label: 'Memorandum — To', type: 'text', default: 'Property Officer' }
      ],
      // The five documents, in filing order. `title` is stored ONCE and
      // rendered in three places — the letter's enclosure list (title case),
      // the proof of service's list (upper case) and the document's own
      // heading. The filed example called the same paper "Answer to Complaint
      // TO Claim and Delivery" in the letter and "ANSWER TO COMPLAINT FOR
      // CLAIM AND DELIVERY" in the proof of service; one stored title is what
      // stops that drift.
      //
      // `title` is the legal title that prints in the enclosure list and the
      // proof of service. `file_label` is what the FILENAME uses, and is
      // deliberately shorter: the full titles carry apostrophes and run to 60
      // characters, and Windows still caps a full path at 260 — output root +
      // matter folder + packet folder + a 90-character filename gets close
      // enough to that to matter for a real client name.
      documents: [
        { doc_type: 'cd_transmittal', title: 'Transmittal Letter',
          file_label: 'Transmittal Letter', role: 'cover' },
        { doc_type: 'cd_memorandum', title: 'Memorandum to Property Officer',
          file_label: 'Memorandum', role: 'internal' },
        { doc_type: 'cd_answer_motion', title: "Defendant's Answer to Motion for Possession Pending Judgment",
          file_label: 'Answer to Motion', role: 'enclosure' },
        { doc_type: 'cd_answer_complaint', title: "Defendant's Answer to Complaint for Claim and Delivery",
          file_label: 'Answer to Complaint', role: 'enclosure' },
        { doc_type: 'cd_proof_of_service', title: 'Proof of Service',
          file_label: 'Proof of Service', role: 'service' }
      ]
    },
    {
      id: 'driver_license_hearing',
      label: 'Driver License Hearing Request',
      // No case number — a DAAD hearing request has none (that's the point
      // of the filing); packetPreflight() skips that check for this kind.
      requiresCaseNumber: false,
      fields: [
        { id: 'packet_date', label: 'Date of Letter', type: 'date' },
        { id: 'hearing_type', label: 'Hearing Type', type: 'text',
          default: 'Implied Consent Refusal',
          help: 'Printed in both the letter and the Appearance.' },
        { id: 'client_dob', label: 'Client — Date of Birth', type: 'date' },
        { id: 'client_license_number', label: 'Client — Driver License No.', type: 'text' },
        { id: 'recipient_name', label: 'Recipient — Name', type: 'text',
          default: 'Driver Assessment and Appeal Division' },
        { id: 'recipient_address', label: 'Recipient — Address', type: 'textarea',
          default: 'P.O. Box 00000\nExampleton, MI 48000' }
      ],
      documents: [
        { doc_type: 'dl_letter', title: 'Covering Letter',
          file_label: 'Covering Letter', role: 'cover' },
        { doc_type: 'dl_appearance', title: 'Appearance and Request for Hearing',
          file_label: 'Appearance and Request for Hearing', role: 'enclosure' }
      ]
    },
    {
      id: 'standalone_letter',
      label: 'Letter',
      // No matter, no case number by definition.
      requiresCaseNumber: false,
      fields: [
        { id: 'packet_date', label: 'Date of Letter', type: 'date' },
        { id: 'confidential', label: 'Mark "Confidential Attorney-Client Communication"', type: 'checkbox' },
        { id: 'subject', label: 'Subject / RE:', type: 'text' },
        { id: 'letter_body', label: 'Body', type: 'textarea',
          help: 'One blank line between paragraphs.' },
        { id: 'cc_list', label: 'cc: (one name per line, optional)', type: 'textarea',
          help: 'Printed at the bottom of the letter, one name per line.' }
      ],
      documents: [
        { doc_type: 'standalone_letter_doc', title: 'Letter', file_label: 'Letter', role: 'cover' }
      ]
    }
  ],

  // The documents in a packet that are actually enclosed/served. Both the
  // transmittal letter and the proof of service read this same list, so they
  // can never disagree about what was sent.
  packetEnclosures(packetDef) {
    return (packetDef.documents || []).filter(d => d.role === 'enclosure');
  },

  renderHtml(blocks, matter, attorney) {
    let html = '';
    for (const block of blocks) {
      if (block.type === 'district_caption') html += renderDistrictCaption(matter);
      else if (block.type === 'appellate_caption') html += renderAppellateCaption(matter);
      else if (block.type === 'centered_bold') html += `<div class="doc-centered-bold">${esc(block.text)}</div>`;
      else if (block.type === 'heavy_rule') html += `<div class="heavy-rule"></div>`;
      else if (block.type === 'respectfully_submitted') html += renderRespectfullySubmitted(matter, attorney, block.dated);
      else if (block.type === 'word_count') html += `<div class="word-count">Number of Countable Words: ${countWords(block.text).toLocaleString()}</div>`;
      else if (block.type === 'title_underlined') html += `<div class="doc-title underlined">${esc(block.text)}</div>`;
      else if (block.type === 'plain') html += `<div class="doc-plain">${esc(block.text)}</div>`;
      else if (block.type === 'form_section') html += `<div class="form-section">${esc(String(block.text || '').toUpperCase())}</div>`;
      else if (block.type === 'form_field') html += renderFormField(block);
      else if (block.type === 'form_table') html += renderFormTable(block.headings, block.rows);
      else if (block.type === 'body') html += `<div class="doc-paragraph">${esc(block.text)}</div>`;
      else if (block.type === 'appearance_signature') html += renderAppearanceSignature(matter, attorney, block.dated, block.noBarNumber);
      else if (block.type === 'caption') html += renderCaptionLegacy(matter, attorney);
      else if (block.type === 'letterhead') html += renderLetterhead(matter.letterhead);
      else if (block.type === 'letter_date') html += `<div class="letter-date">${esc(block.text)}</div>`;
      else if (block.type === 'recipient_block') html += renderRecipient(block);
      else if (block.type === 're_block') html += renderReBlock(block.lines, block.plain);
      else if (block.type === 'to_the_above') html += `<div class="to-the-above">TO THE ABOVE:</div>`;
      else if (block.type === 'salutation') html += renderSalutation(block.text);
      else if (block.type === 'daad_caption') html += renderDaadCaption(matter, block);
      else if (block.type === 'stipulation_clause') html += renderStipulationClause(block.hearingType, block.from, block.reason);
      else if (block.type === 'dual_signature') html += renderDualSignature(block);
      else if (block.type === 'order_session') html += renderOrderSession(matter);
      else if (block.type === 'order_clause') html += renderOrderClause(block.hearingType, block.from);
      else if (block.type === 'judge_signature') html += renderJudgeSignature();
      else if (block.type === 'letter_body') html += `<div class="letter-body">${esc(block.text)}</div>`;
      else if (block.type === 'enclosure_list') html += renderEnclosureList(block.items);
      else if (block.type === 'letter_close') html += renderLetterClose(block.closing, attorney, matter.letterhead);
      else if (block.type === 'ref_initials') html += renderRefInitials(attorney, matter.letterhead);
      else if (block.type === 'cc_block') {
        const names = (block.names || []).filter(Boolean);
        if (names.length) {
          html += `<div class="cc-block"><div class="cc-label">cc:</div><div class="cc-names">${
            names.map(n => `<div>${esc(n)}</div>`).join('')
          }</div></div>`;
        }
      }
      else if (block.type === 'memo_labels') html += renderMemoLabels(block.rows);
      else if (block.type === 'item_line') html += renderItemLine(block.text);
      else if (block.type === 'numbered_answers') html += renderNumberedAnswers(block.items);
      else if (block.type === 'counsel_block') html += renderCounselBlock(matter, attorney);
      else if (block.type === 'pos_derived') html += renderPosDerived(block);
      else if (block.type === 'title') html += `<div class="doc-title">${esc(block.text)}</div>`;
      else if (block.type === 'paragraph') html += `<div class="doc-paragraph">${esc(block.text)}</div>`;
      else if (block.type === 'freetext') html += renderFreeText(block.text);
      else if (block.type === 'spacer') html += `<div style="height: ${block.lines * 2}em"></div>`;
      else if (block.type === 'signature') html += renderSignature(attorney);
      else if (block.type === 'pagebreak') html += `<div class="page-break"></div>`;
      else if (block.type === 'proof_of_service' || block.type === 'proof_of_service_block') {
        const fields = block.data || {};
        const date = fields.service_date ? formatDate(fields.service_date) : new Date().toLocaleDateString();
        const method = fields.service_method || 'first-class mail';
        const docs = fields.documents_served || 'the foregoing document';
        html += `<div class="doc-title underlined" style="margin-top:0;">PROOF OF SERVICE</div>
                 <div class="doc-paragraph">
                   I hereby certify that on ${esc(date)}, I served a copy of ${esc(docs)} upon the following attorneys of record or parties in pro per via ${esc(method)}:
                 </div>
                 <div style="white-space: pre-wrap; margin-left: 0.5in; line-height: 1.15; margin-top: 1em; margin-bottom: 2em;">${esc(matter.opposing_counsel || '[Opposing Counsel Not Specified]')}</div>
                 ${renderSignature(attorney)}`;
      }
    }
    return html;
  }
};

// Escape text before it is concatenated into HTML. Matter data is typed by the
// user and routinely contains "&" (FLEE & ELUDE FELONY, ROE & ASSOCIATES
// P.L.L.C.); a "<" would silently corrupt the caption. The resulting HTML is
// also loaded into a BrowserWindow to make the PDF, so unescaped input would be
// parsed as markup there too.
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Returns the array of full names to actually print, honoring
// matter.caption_style: 'full' (list every party) | 'et_al' (collapse to
// "FirstName, et al." once count > 1 — the long-standing default) |
// 'et_al_force' (always "FirstName, et al.", even with exactly one named
// party — for when others are known to exist but aren't entered yet).
// Callers that need one joined line use .join(', ')/.join('<br>')
// themselves; callers that print one line per name map over the array
// directly. Mirrored in main.js per ground rule 0.2.
function partyCaptionNames(parties, side, style) {
  const p = (parties || []).filter(x => x.side === side).sort((a,b) => a.sort_order - b.sort_order);
  if (p.length === 0) return [];
  if (style === 'et_al_force') return [`${p[0].name}, et al.`];
  if (style === 'full') return p.map(x => x.name);
  return p.length > 1 ? [`${p[0].name}, et al.`] : [p[0].name];
}

// Shared by every caption variant and case-name helper in this file and
// main.js's .docx export (ground rule 0.2). Thin wrapper around
// partyCaptionNames() for callers that just want one joined string.
function partyCaptionText(parties, side, style) {
  const names = partyCaptionNames(parties, side, style);
  if (names.length === 0) return side === 'plaintiff' ? 'Plaintiff' : 'Defendant';
  return names.join(', ');
}

// "December 23, 2025" — the form used on the source filings.
function formatLongDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString();
}

function renderFreeText(text) {
  if (!text) return '';
  const pars = text.split('\n\n').map(p => p.trim()).filter(p => p.length > 0);
  return pars.map(p => `<div class="doc-paragraph">${esc(p).replace(/\n/g, '<br>')}</div>`).join('');
}

// Bar number is BARE in a signature block — brackets belong to the counsel
// block at the top of the page (settled 2026-08-18, decision 6). Empty fields
// are dropped rather than printed as blank lines, which is what the Word
// export already did; the two used to disagree on the spacing.
// Mirrored by pushSignature() in main.js.
function signatureLines(attorney) {
  const a = attorney || {};
  return [
    [a.name, a.bar_number].filter(Boolean).join(' '),
    a.firm_name || '',
    ...String(a.firm_address || '').split('\n'),
    a.firm_phone || '',
    a.firm_email || ''
  ].map(l => String(l == null ? '' : l).trim()).filter(Boolean);
}

function renderSignature(attorney) {
  const [nameLine, ...rest] = signatureLines(attorney);
  return `
    <div class="signature-block">
      <div class="sig-date">Date: _______________</div>
      <div class="sig-lines">
        <div style="margin-bottom: 0.5em;">/s/ ${esc((attorney || {}).name || '')}</div>
        <div class="sig-name">${esc(nameLine || '')}</div>
        ${rest.map(l => `<div>${esc(l)}</div>`).join('')}
      </div>
    </div>
  `;
}

// The line printed under STATE OF MICHIGAN. Stored per court and emitted
// verbatim: a judicial district court, a circuit court and a state agency are
// different institutions that name themselves their own way, so there is no
// rule to compute and nothing to normalize. Never upper-case it — the source
// filings print "96th", never "96TH". Falls back to the old interpolation for a court
// saved before header_line existed.
function courtHeaderLine(matter) {
  const stored = (matter.court_header_line || '').trim();
  if (stored) return stored;
  return matter.court_name ? `IN THE ${matter.court_name}` : 'IN THE [COURT]';
}

// The free note lines in the caption's right-hand column, in order.
//
// The right column is a stack, not a fixed set of fields — one to four lines
// across the filed examples. Charge information lives in that stack ("BAC .XX
// >", "Overweight"), so charges are note lines, not a separate concept. A
// compound entry like "OWI, Speed 11-15, BAC 0.XX" is one row or three, and
// either way nothing else in the caption moves.
//
// matter.charges is the RETIRED single-TEXT column, read here for one reason
// only: documents generated before migration 12 carry a matter_snapshot that
// has `charges` and no `caption_notes`, and regenerating one of those must
// still print its notes. Nothing else may read it.
// Mirrored by captionNoteLines() in main.js — the two renderers are separate
// engines, so if this drifts, Word and PDF print different captions.
function captionNoteLines(matter) {
  if (Array.isArray(matter.caption_notes)) {
    return matter.caption_notes
      .map(n => String(n && n.note_text != null ? n.note_text : n).trim())
      .filter(Boolean);
  }
  return String(matter.charges || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// Party-role wording. One source, so the caption label, the body sentence and
// the signature block can never disagree — which they do in the hand-made
// templates this replaces.
//
// roleWords is the DEFENDANT side's label — what the caption prints under the
// defendant's name, whoever we represent.
function roleWords(matter) {
  const label = matter.party_label || 'Defendant';
  return { label, lower: label.toLowerCase() };
}

// OUR side's label: "attorney of record for …", "Attorney for …". Follows
// matters.client_role, so a prosecuting City signs for the plaintiff instead
// of printing "Attorney for Defendant". Anything but 'plaintiff' (including an
// unset role) is the defense side, exactly as before.
// Mirrored by ourRoleLabel in main.js's Word export.
function ourRoleWords(matter) {
  const label = matter.client_role === 'plaintiff'
    ? (matter.plaintiff_label || 'Plaintiff')
    : (matter.party_label || 'Defendant');
  return { label, lower: label.toLowerCase() };
}

// The authority that appears above "Plaintiff": PEOPLE OF THE STATE OF
// MICHIGAN, PEOPLE OF CITY OF EXAMPLETON, and so on. Per-matter override wins,
// then the matter type's default, then the parties themselves for civil work.
function captionAuthority(matter) {
  if (matter.caption_authority && matter.caption_authority.trim()) return matter.caption_authority.trim().toUpperCase();
  if (matter.type_caption_authority && matter.type_caption_authority.trim()) return matter.type_caption_authority.trim().toUpperCase();
  return null;
}

// The plaintiff line when there is no caption authority: the plaintiff
// parties, upper-cased, or the bracketed "[PLAINTIFF]" blank when there are
// none — the same convention as "[DEFENDANT]" (partyCaptionText's bare
// "Plaintiff" fallback read as filled in). Mirrored in main.js's Word export.
function plaintiffCaptionText(matter) {
  const plaintiffs = (matter.parties || []).filter(p => p.side === 'plaintiff');
  return plaintiffs.length
    ? partyCaptionText(matter.parties || [], 'plaintiff', matter.caption_style).toUpperCase()
    : '[PLAINTIFF]';
}

// District court caption, matching the filed appearances: authority over
// "Plaintiff" on the left, case number / judge / notes stacked on the right, vs.
// between the parties, and the "/" closer beneath.
function renderDistrictCaption(matter) {
  const { label } = roleWords(matter);
  const plLabel = matter.plaintiff_label || 'Plaintiff';
  const authority = captionAuthority(matter) || plaintiffCaptionText(matter);
  const defendants = (matter.parties || []).filter(p => p.side === 'defendant');
  // NOTE: comma-joined here to match main.js's existing 'full'-mode behavior
  // for this same column — no filed multi-defendant example was found to
  // confirm this against the previous, un-consolidated '<br>'-joined
  // behavior this replaces. Flagged unverified; see the et-al-override plan.
  const defendantText = defendants.length
    ? partyCaptionText(matter.parties || [], 'defendant', matter.caption_style)
    : '[DEFENDANT]';

  // Right-hand column, top to bottom: case number, judge, then the free note
  // lines (see captionNoteLines).
  const rightLines = [];
  if (matter.case_number && !matter.case_number_pending) rightLines.push(`Case No. ${matter.case_number}`);
  if (matter.judge_name) rightLines.push(`Hon. ${matter.judge_name}`);
  rightLines.push(...captionNoteLines(matter));
  const rightHtml = rightLines.map(t => `<div>${esc(t)}</div>`).join('');

  return `
    <div class="caption-block">
      <div class="court-header">
        STATE OF MICHIGAN<br>
        ${esc(courtHeaderLine(matter))}
      </div>
      <table class="caption-grid">
        <tr>
          <td class="cap-left">
            <div class="cap-party">${esc(authority)}</div>
            <div class="cap-role">${esc(plLabel)}</div>
          </td>
          <td class="cap-right">${rightHtml}</td>
        </tr>
        <tr>
          <td class="cap-left"><div class="cap-vs">vs.</div></td>
          <td class="cap-right"></td>
        </tr>
        <tr>
          <td class="cap-left">
            <div class="cap-party">${esc(defendantText.toUpperCase())}</div>
            <div class="cap-role">${esc(label)}</div>
          </td>
          <td class="cap-right"></td>
        </tr>
      </table>
      <div class="cap-closer"><span class="rule"></span><span class="slash">/</span></div>
    </div>
  `;
}

// Scanned signature, if one is set on the attorney record. The src is a data:
// URI written by the main process from a file the user picked, so it is not
// free text; the alt attribute is fixed.
function signatureImageHtml(attorney) {
  if (!attorney || !attorney.signature_image) return '';
  return `<div class="sig-image"><img src="${attorney.signature_image}" alt="Signature"></div>`;
}

// MCR 7.212 countable words. Placeholder text in square brackets is not part
// of the argument, so it is excluded from the count.
function countWords(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter(w => /[A-Za-z0-9]/.test(w))
    .length;
}

// Closing block on the reference brief: "Respectfully submitted," then /S/ over the rule.
function renderRespectfullySubmitted(matter, attorney, dated) {
  const ourLabel = matter.client_role === 'plaintiff'
    ? (matter.plaintiff_label || 'Plaintiff')
    : (matter.party_label || 'Defendant');
  const lines = [
    `${esc((attorney.name || '').toUpperCase())} ${esc(attorney.bar_number || '')}`,
    `Attorney for ${esc(ourLabel)}`,
    ...String(attorney.firm_address || '').split('\n').map(esc),
    esc(attorney.firm_phone || '')
  ].filter(Boolean);
  return `
    <div class="sig-appearance">
      <div>Respectfully submitted,</div>
      ${attorney.signature_image ? signatureImageHtml(attorney) : '<div class="sig-sig">/S/</div>'}
      ${dated ? `<div class="sig-date-line">Date: ${esc(dated)}</div>` : ''}
      <div class="sig-rule">_____________________________</div>
      <div class="sig-lines">${lines.map(l => `<div>${l}</div>`).join('')}</div>
    </div>
  `;
}

// Appellate caption, from the reference Circuit Court brief: compound party roles, one
// Case No./Hon. pair per court involved (the appeal and the case below), then
// both counsel blocks side by side between two rules.
function renderAppellateCaption(matter) {
  const plLabel = matter.plaintiff_label || 'Plaintiff';
  const defLabel = matter.party_label || 'Defendant';
  const authority = captionAuthority(matter) || plaintiffCaptionText(matter);
  const defendants = (matter.parties || []).filter(p => p.side === 'defendant');
  const defendantText = defendants.length
    ? partyCaptionText(matter.parties || [], 'defendant', matter.caption_style)
    : '[DEFENDANT]';

  // One block per case: number over judge, blank line between blocks.
  const cases = (matter.cases && matter.cases.length ? matter.cases : [{
    case_number: matter.case_number, judge_name: matter.judge_name
  }]).filter(c => c.case_number || c.judge_name);

  const caseBlocks = cases.map(c => `
    <div class="cap-case">
      <div>Case No. ${esc(c.case_number && !matter.case_number_pending ? c.case_number : '____________')}</div>
      <div>Hon. ${esc(c.judge_name || '____________')}</div>
    </div>`).join('')
    // The note stack sits at the foot of the identifier column here too. No
    // filed appellate example carries notes, but the stack rule is general and
    // the alternative is that notes typed on an appellate matter silently
    // print nowhere.
    + captionNoteLines(matter).map(t => `<div>${esc(t)}</div>`).join('');

  const ours = matter.our_counsel || {};
  const theirs = matter.opposing_counsel_person || {};
  // Our block carries our side's role; theirs carries the other side's.
  const ourLabel = matter.client_role === 'plaintiff' ? plLabel : defLabel;
  const theirLabel = matter.client_role === 'plaintiff' ? defLabel : plLabel;
  // A counsel block with no name is worse than none: the caption printed a bare
  // "Attorney for Defendant" under an empty column. Fall back to the free-text
  // opposing counsel block, then to nothing at all.
  const counselBlock = (c, roleLabel, fallbackText, coCounsel) => {
    const hasPerson = c && (c.name || c.firm_name);
    if (!hasPerson) {
      const text = (fallbackText || '').trim();
      if (!text) return '';
      return text.split('\n').map(l => `<div>${esc(l)}</div>`).join('');
    }
    const nameLines = coCounsel
      ? counselNameLines(c, coCounsel)
      : (c.name ? [`${c.name}${c.bar_number ? ` (${c.bar_number})` : ''}`] : []);
    return [
      c.firm_name || '',
      ...nameLines,
      roleLabel ? `Attorney for ${roleLabel}` : '',
      ...(c.address || '').split('\n'),
      c.phone || '',
      c.email || ''
    ].filter(Boolean).map(l => `<div>${esc(l)}</div>`).join('');
  };

  return `
    <div class="caption-block">
      <div class="court-header">
        STATE OF MICHIGAN<br>
        ${esc(courtHeaderLine(matter))}
      </div>
      <table class="caption-grid appellate">
        <tr>
          <td class="cap-left">
            <div class="cap-party">${esc(authority)},</div>
            <div>${esc(plLabel)},</div>
          </td>
          <td class="cap-right">${caseBlocks}</td>
        </tr>
        <tr>
          <td class="cap-left"><div class="cap-vs">vs.</div></td>
          <td class="cap-right"></td>
        </tr>
        <tr>
          <td class="cap-left">
            <div class="cap-party">${esc(defendantText.toUpperCase())},</div>
            <div>${esc(defLabel)},</div>
          </td>
          <td class="cap-right"></td>
        </tr>
      </table>
      <div class="counsel-rule"></div>
      <table class="counsel-grid">
        <tr>
          <td>${counselBlock(ours, ourLabel, null, matter.co_counsel)}</td>
          <td>${counselBlock(theirs, theirLabel, matter.opposing_counsel)}</td>
        </tr>
      </table>
      <div class="counsel-rule"></div>
    </div>
  `;
}

// Signature block as it appears on the source filings: right half of the page, rule,
// name and bar number, role, address, phone. Email only when there is one.
function renderAppearanceSignature(matter, attorney, dated, noBarNumber) {
  const { label } = ourRoleWords(matter);
  // Bar number is bare in a signature block but bracketed in the counsel block
  // at the top of the page. Both are deliberate — confirmed 2026-08-18.
  // noBarNumber drops it entirely: the filed proof of service signs with the
  // name and office line only.
  const nameLine = noBarNumber
    ? (attorney.name || '').toUpperCase()
    : `${(attorney.name || '').toUpperCase()} ${attorney.bar_number || ''}`.trim();
  const rest = noBarNumber
    ? [attorney.firm_name || ''].filter(Boolean)
    : [
        `Attorney for ${label}`,
        attorney.firm_address || '',
        attorney.firm_phone || ''
      ].filter(Boolean);
  return `
    <div class="sig-appearance">
      ${signatureImageHtml(attorney)}
      ${dated ? `<div class="sig-date-line">Date: ${esc(dated)}</div>` : ''}
      <div class="sig-rule">_____________________________</div>
      <div class="sig-lines">
        <div class="sig-name">${esc(nameLine)}</div>
        ${rest.map(l => `<div>${esc(l)}</div>`).join('')}
      </div>
    </div>
  `;
}

// ---- Packet / letter blocks -----------------------------------------------
// Every function here has a mirror in main.js's Word export (ground rule 0.2).
// The wording is transcribed from filed documents; the layout follows spec §09.

// The case name that prints in a RE: block: "PLAINTIFF v Defendant".
// The plaintiff is the packet's named recipient (the person suing for their
// property back); the defendant is our client. A side with nobody on it
// prints the bracketed "[PLAINTIFF]" / "[DEFENDANT]" blank, chosen on the
// party count like plaintiffCaptionText(): partyCaptionText never returns
// empty, so a "|| '[…]'" after it could never fire. The Word export prints
// these lines as built here (re_block / memo_labels carry the text), so this
// one function covers both engines.
function packetCaseName(matter, packet) {
  const parties = matter.parties || [];
  const has = (side) => parties.some(p => p.side === side);
  const plaintiff = (packet && packet.recipient_name)
    || (has('plaintiff') ? partyCaptionText(parties, 'plaintiff', matter.caption_style) : '[PLAINTIFF]');
  const defendant = has('defendant')
    ? partyCaptionText(parties, 'defendant', matter.caption_style)
    : '[DEFENDANT]';
  return `${plaintiff.toUpperCase()} v ${defendant}`;
}

// ---- Driver-license hearing request packet ---------------------------------

// The client's identity, as it prints on both the covering letter and the
// Appearance: name comes from the matter's own defendant-side party — the
// same "our client" convention every other doctype already uses via
// partyCaptionText — so the two documents can never name the client differently.
// DOB and license number are packet-scoped (see migration 14's comment for
// why), not read from `people`.
// Mirrored inline in main.js.
function driverLicenseClient(matter, packet) {
  const p = packet || {};
  return {
    name: partyCaptionText(matter.parties || [], 'defendant', matter.caption_style) || '[CLIENT NAME]',
    license: p.client_license_number || '____________',
    dob: formatDate(p.client_dob) || '____________'
  };
}

// "a"/"an" for a data-driven noun phrase ("an Implied Consent Refusal
// hearing"). Ordinary English grammar on a slot, not invented legal wording —
// the sentence itself is transcribed verbatim from the filed letter.
function withArticle(phrase) {
  return /^[aeiou]/i.test(String(phrase || '').trim()) ? 'an' : 'a';
}

// The fixed DAAD header (spec §02) plus the IN RE: identity block. Hardcoded
// text, not a stored-per-court header_line like the district caption: there
// is exactly one Driver Assessment and Appeal Division in Michigan, so there
// is no "different institutions name themselves differently" problem to
// solve. Note the header's own name for the office ("DRIVER LICENSE APPEAL
// DIVISION") differs from the mailing address's ("Driver Assessment and
// Appeal Division") — that is what the filed exhibit actually does, not a
// typo, and it is reproduced as filed rather than normalized.
// Mirrored by pushDaadCaption() in main.js.
function renderDaadCaption(matter, block) {
  const c = driverLicenseClient(matter, block && block.packet);
  return `
    <div class="caption-block daad-caption">
      <div class="court-header">
        STATE OF MICHIGAN<br>
        IN THE MICHIGAN DEPARTMENT OF STATE<br>
        BUREAU OF DRIVER IMPROVEMENT<br>
        DRIVER LICENSE APPEAL DIVISION
      </div>
      <div class="daad-in-re">
        <div class="re-label">IN RE:</div>
        <div class="re-lines">
          <div>${esc(c.name.toUpperCase())}</div>
          <div>Driver License No. ${esc(c.license)}</div>
          <div>Date of Birth:  ${esc(c.dob)}</div>
        </div>
      </div>
    </div>
  `;
}

// "Dear Sir/Madam" — no colon, no comma (decision 10). Mirrored in main.js.
function renderSalutation(text) {
  return `<div class="salutation">Dear ${esc(text)}</div>`;
}

// ---- Stipulation and order (Phase 4) ---------------------------------------
// Every function here has a mirror in main.js's Word export (ground rule 0.2).
// Wording transcribed from spec §08 and the filed exhibit; where the filed
// working file's own formatting drifted from both the spec and the clean
// filed PDF (a bold run landed on the wrong words), the spec/PDF win — see
// the build-plan's Phase 4 notes.

// The fixed stipulation sentence. Bold lead-in only; the two date slots are
// underlined. The second slot is always this literal phrase — nobody knows
// the new date at filing time, so it is not a user-entered field.
// Mirrored by pushStipulationClause() in main.js.
function renderStipulationClause(hearingType, from, reason) {
  return `
    <div class="stip-clause">
      <strong>IT IS HEREBY STIPULATED</strong> by the parties hereto, by and through their attorneys, that the above ${esc(hearingType)} be adjourned from <span class="u">${esc(from)}</span> to <span class="u">(date set by the court)</span> for the reason that ${esc(reason)}.
    </div>
  `;
}

// Two attorneys side by side, closing the stipulation. Generic — no
// stipulation-specific wording lives here, only line data the doctype's
// build() supplies — so it is reusable for any side-by-side counsel need,
// per the build plan. `sig: true` prints "/s/" above the rule (electronic
// signature); an `attorney` with a signature_image prints that instead;
// neither prints a blank space the same height, matching the filed exhibit
// where the attorney signs by hand and opposing counsel signs electronically.
// Mirrored by pushDualSignature() in main.js.
function renderDualSignature(block) {
  const renderLines = (lines) => (lines || [])
    .map(l => `<div${l.bold ? ' class="ds-name"' : ''}>${esc(l.text)}</div>`)
    .join('');
  const topSlot = (side) => {
    if (side.sig) return '<div class="ds-sig-slot">/s/</div>';
    if (side.attorney && side.attorney.signature_image) return `<div class="ds-sig-slot">${signatureImageHtml(side.attorney)}</div>`;
    return '<div class="ds-sig-slot"></div>';
  };
  const cell = (side) => `
    <td>
      ${topSlot(side)}
      <div class="ds-rule"></div>
      ${renderLines(side.lines)}
    </td>
  `;
  return `
    <table class="dual-sig-grid">
      <tr>${cell(block.left || {})}${cell(block.right || {})}</tr>
    </table>
  `;
}

// The ORDER page's fixed preamble: "At a session... / Present: / HONORABLE".
// Court name and city print exactly as stored (never upper-cased), same rule
// as the header line. "DISTRICT COURT JUDGE" is filed text from the one
// example in hand, a district court — a circuit-court stipulation would need
// a filed example before this literal string is trusted for it (rule 3).
// Mirrored by pushOrderSession() in main.js.
function renderOrderSession(matter) {
  const courtName = matter.court_name || '[COURT]';
  const city = matter.court_city || '[CITY]';
  const county = matter.court_county || '[COUNTY]';
  const judge = matter.judge_name || '____________';
  return `
    <div class="order-block order-session">
      <div>At a session of the ${esc(courtName)} held in the City of ${esc(city)}</div>
      <div>County of ${esc(county)}, State of Michigan</div>
      <div>On <span class="order-blank"></span></div>
      <div>Present:</div>
      <div>HONORABLE&nbsp;&nbsp;${esc(judge)}</div>
      <div>DISTRICT COURT JUDGE</div>
    </div>
  `;
}

// The ORDER page's fixed sentence. The FROM date must be the exact same
// string stipulation_clause printed on page 1 — the doctype's build()
// computes it once and passes it to both blocks, which is the actual fix for
// the two-different-dates defect the filed working file demonstrates. The
// TO date is left genuinely blank; the clerk fills it in by hand once the
// court sets a new date.
// Mirrored by pushOrderClause() in main.js.
function renderOrderClause(hearingType, from) {
  return `
    <div class="order-block">
      <div>Upon reading and filing the above Stipulation and the Court being apprised of the premises;</div>
      <div><strong>IT IS HEREBY ORDERED</strong> that the above ${esc(hearingType)} be adjourned from <span class="u">${esc(from)}</span> to <span class="order-blank"></span></div>
    </div>
  `;
}

// The judge's own signature line: no bar number, no address. Centered,
// unlike appearance_signature's left-indented block, but the same
// literal-underscore rule convention.
// Mirrored by pushJudgeSignature() in main.js.
function renderJudgeSignature() {
  return `
    <div class="order-block judge-sig">
      <div class="sig-rule">_____________________________</div>
      <div>District Court Judge</div>
    </div>
  `;
}

// City letterhead: masthead, office lines and address centered, the office's
// other attorneys down the left, seal at top right. All of it is stored data
// (a letterhead profile), never hard-coded — the app must never ship one
// municipality's branding.
//
// A personal letterhead (spec §09) is a structurally different layout, not a
// variant of this one: name bold at left, "Attorney at Law" beneath it,
// address/phone right-aligned, no seal, no names down the side. Branches on
// `lh.kind`, mirrored by pushLetterhead() in main.js.
function renderLetterhead(lh) {
  if (!lh) return '<div class="letterhead letterhead-missing">[NO LETTERHEAD SELECTED]</div>';
  if (lh.kind === 'personal') return renderPersonalLetterhead(lh);
  const side = String(lh.side_names || '').split('\n').map(s => s.trim()).filter(Boolean);
  const office = String(lh.office_lines || '').split('\n').map(s => s.trim()).filter(Boolean);
  const addr = String(lh.address || '').split('\n').map(s => s.trim()).filter(Boolean);
  const contact = [lh.phone, lh.fax ? `FAX ${lh.fax}` : ''].filter(Boolean).join('  /  ');
  return `
    <div class="letterhead">
      <div class="lh-side">${side.map(l => `<div>${esc(l)}</div>`).join('')}</div>
      <div class="lh-center">
        <div class="lh-masthead">${esc(lh.masthead || '')}</div>
        ${office.map(l => `<div class="lh-office">${esc(l)}</div>`).join('')}
        ${addr.map(l => `<div>${esc(l)}</div>`).join('')}
        ${contact ? `<div class="lh-contact">${esc(contact)}</div>` : ''}
      </div>
      <div class="lh-seal">${lh.seal_image ? `<img src="${lh.seal_image}" alt="Seal">` : ''}</div>
    </div>
  `;
}

function renderPersonalLetterhead(lh) {
  const office = String(lh.office_lines || '').split('\n').map(s => s.trim()).filter(Boolean);
  const addr = String(lh.address || '').split('\n').map(s => s.trim()).filter(Boolean);
  const contact = [lh.phone, lh.fax ? `FAX ${lh.fax}` : ''].filter(Boolean).join('  /  ');
  return `
    <div class="letterhead letterhead-personal">
      <div class="lhp-left">
        <div class="lhp-name">${esc(lh.masthead || '')}</div>
        ${office.map(l => `<div class="lhp-office">${esc(l)}</div>`).join('')}
      </div>
      <div class="lhp-right">
        ${addr.map(l => `<div>${esc(l)}</div>`).join('')}
        ${contact ? `<div>${esc(contact)}</div>` : ''}
      </div>
    </div>
  `;
}

function renderRecipient(block) {
  const lines = String(block.address || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!block.name && !lines.length) return '';
  return `
    <div class="recipient-block">
      ${block.name ? `<div class="recipient-name">${esc(block.name)}</div>` : ''}
      ${lines.map(l => `<div>${esc(l)}</div>`).join('')}
    </div>
  `;
}

// Indented RE: block. Its subject lines are bold; the second line is also
// italic by default, matching the C&D filings' case-name line ("PLAINTIFF v
// Defendant"). `plain: true` (the driver-license letter's name/license/DOB
// block, none of which is a case name) suppresses that italic — mirrored by
// pushReBlock() in main.js.
function renderReBlock(lines, plain) {
  const rows = (lines || []).filter(Boolean);
  if (!rows.length) return '';
  return `
    <div class="re-block">
      <div class="re-label">RE:</div>
      <div class="re-lines">
        ${rows.map((l, i) => `<div class="${!plain && i === 1 ? 're-casename' : ''}">${esc(l)}</div>`).join('')}
      </div>
    </div>
  `;
}

// The enclosure list, with "and" between two items. Derived from the packet,
// never typed — this is the whole point of a packet knowing its contents.
function renderEnclosureList(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return '';
  const parts = [];
  list.forEach((t, i) => {
    if (i > 0) parts.push('<div class="encl-and">and</div>');
    parts.push(`<div class="encl-item">${esc(t)}</div>`);
  });
  return `<div class="enclosure-list">${parts.join('')}</div>`;
}

// Letters close with the typed name and NO bar number (spec §09).
function renderLetterClose(closing, attorney, lh) {
  const office = (lh && lh.office_lines)
    ? String(lh.office_lines).split('\n').map(s => s.trim()).filter(Boolean)[1] || ''
    : '';
  return `
    <div class="letter-close">
      <div>${esc(closing || 'Very truly yours,')}</div>
      ${signatureImageHtml(attorney)}
      <div class="lc-name">${esc((attorney.name || '').toUpperCase())}</div>
      ${office ? `<div>${esc(titleCaseOffice(office))}</div>` : ''}
    </div>
  `;
}

function titleCaseOffice(s) {
  return String(s || '').replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// Reference initials, bottom left. The separator belongs to the LETTERHEAD —
// a slash on personal letterhead, a colon on city letterhead — and is
// deliberate, not drift (spec §09, decision 9).
function renderRefInitials(attorney, lh) {
  const typist = (lh && lh.typist_initials) || '';
  const sep = typist ? ((lh && lh.ref_separator) || ':') : '';
  const initials = initialsOf(attorney && attorney.name);
  if (!initials) return '<div class="ref-initials">Encl.</div>';
  return `<div class="ref-initials"><div>${esc(initials)}${esc(sep)}${esc(typist)}</div><div>Encl.</div></div>`;
}

function initialsOf(name) {
  return String(name || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('');
}

// The memo's four-row label block: labels in a fixed left column, values
// aligned in a second. A value may run to several lines.
function renderMemoLabels(rows) {
  return `
    <div class="memo-labels">
      ${(rows || []).map(r => {
        const vals = String(r.value || '').split('\n');
        return `
          <div class="memo-label">${esc(r.label)}</div>
          <div class="memo-value">${vals.map((v, i) =>
            `<div class="${r.emphasizeFrom != null && i >= r.emphasizeFrom ? 'memo-em' : ''}">${esc(v)}</div>`
          ).join('')}</div>`;
      }).join('')}
    </div>
  `;
}

// The seized item(s), bold and indented, printed verbatim. One per line.
function renderItemLine(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return '<div class="item-line">[NO ITEM DESCRIBED]</div>';
  return `<div class="item-line">${lines.map(l => `<div>${esc(l)}</div>`).join('')}</div>`;
}

// Numbered answer paragraphs, verbose register (decision 8). An item block can
// sit between two paragraphs, which is how the filed answers print the
// property description.
function renderNumberedAnswers(items) {
  return (items || []).map((it, i) => `
    <div class="answer-para">
      <div class="ap-num">${i + 1}.</div>
      <div class="ap-text">${esc(it.text)}</div>
    </div>
    ${it.itemAfter ? renderItemLine(it.itemAfter) : ''}
  `).join('');
}

// The counsel block under the caption's rule, closed by a second rule. One
// side only — the filed claim & delivery packets have an unrepresented
// plaintiff, so there is no right-hand column (spec §04).
function renderCounselBlock(matter, attorney) {
  const lines = counselLines(attorney, ourRoleWords(matter).label, matter.co_counsel);
  // Bold = names only (decision 5), so EVERY stacked name line is bold, not
  // just the first. This used to bold line 0 unconditionally, which was
  // indistinguishable from correct while a counsel block held one attorney.
  const nameCount = counselNameLines(attorney, matter.co_counsel).length;
  return `
    <div class="counsel-block">
      ${lines.map((l, i) => i < nameCount
          ? `<div class="cb-name">${esc(l)}</div>`
          : `<div>${esc(l)}</div>`).join('')}
      <div class="cap-closer"><span class="rule"></span><span class="slash">/</span></div>
    </div>
  `;
}

// Proof of service whose document list is DERIVED from the packet.
function renderPosDerived(b) {
  const docs = (b.documents || []).filter(Boolean);
  return `
    <div class="pos-venue">
      <div>STATE OF MICHIGAN</div><div>)</div>
      <div class="pos-ss">SS</div><div>)</div>
      <div>COUNTY OF ${esc((b.county || '').toUpperCase() || '____________')}</div><div>)</div>
    </div>
    <div class="letter-body">The undersigned party hereby certifies that he has served copies of the following documents:</div>
    <div class="pos-docs">${docs.map(d => `<div>${esc(d)}</div>`).join('')}</div>
    <div class="pos-line"><span class="pos-lbl">TO:</span> ${esc(b.to || '____________')}</div>
    <div class="pos-line"><span class="pos-lbl">ON:</span> ${esc(b.on || '____________')} by First Class Mail, postage fully prepaid, addressed as stated above.</div>
  `;
}

function renderCaptionLegacy(matter, attorney) {
  const parties = matter.parties || [];

  const getPartyLines = (side) => partyCaptionNames(parties, side, matter.caption_style)
    .map(name => `<div>${esc(name)},</div>`).join('');

  const plRole = legacyRoleWord(matter, 'plaintiff');
  const defRole = legacyRoleWord(matter, 'defendant');

  const rightNotes = captionNoteLines(matter).map(t => `<div>${esc(t)}</div>`).join('');

  return `
    <div class="caption-block">
      <div class="court-header">
        STATE OF MICHIGAN<br>
        ${esc(courtHeaderLine(matter))}
      </div>
      <div class="caption-table">
        <div class="caption-left">
          <div class="party-list">${getPartyLines('plaintiff')}</div>
          <div class="party-role">${esc(plRole)},</div>
          <div class="v-separator">vs.</div>
          <div class="party-list">${getPartyLines('defendant')}</div>
          <div class="party-role">${esc(defRole)}.</div>
        </div>
        <div class="caption-right">
          <div style="margin-bottom: 1em;">Case No. ${esc(matter.case_number && !matter.case_number_pending ? matter.case_number : '____________')}</div>
          <div>Hon. ${esc(matter.judge_name || '____________')}</div>
          ${rightNotes}
        </div>
      </div>
      <div class="caption-bottom-rule"></div>
      <div class="attorney-info">
        ${counselLines(attorney, matter.client_role === 'plaintiff' ? plRole : defRole, matter.co_counsel)
          .map(l => esc(l)).join('<br>')}
      </div>
    </div>
  `;
}

// The role word under a party name in the legacy caption.
//
// It used to be derived from how many parties were on that side, which meant
// it ignored the matter's own label: a matter set to "Respondent" printed
// "Defendant" here while its signature block said "Attorney for Respondent" —
// the two contradicting each other inside one document, which is the exact
// failure this app was built to remove. The matter's label wins now, as it
// already does in the district and appellate captions.
//
// Pluralising is kept for the untouched defaults only, so a two-plaintiff
// civil caption still reads "Plaintiffs" while an explicit label is never
// second-guessed.
// Mirrored by legacyRoleWord() in main.js.
function legacyRoleWord(matter, side) {
  const label = side === 'plaintiff'
    ? (matter.plaintiff_label || 'Plaintiff')
    : (matter.party_label || 'Defendant');
  const count = (matter.parties || []).filter(p => p.side === side).length;
  if (count > 1 && (label === 'Plaintiff' || label === 'Defendant')) return `${label}s`;
  return label;
}

// The counsel block's lines, with the empty ones dropped.
//
// These used to be built by interpolation, so an attorney with no bar number
// printed a bare "()" and one with no email printed a dangling "phone | ".
// The Word export was worse: it interpolated the same fields without esc()'s
// null handling, so a missing value reached the page as the literal text
// "undefined". Neither belongs on a filed document.
// Mirrored by counselLines() in main.js.
function counselLines(attorney, roleLabel, coCounsel) {
  const a = attorney || {};
  const contact = [a.firm_phone, a.firm_email].filter(Boolean).join(' | ');
  return [
    ...counselNameLines(a, coCounsel),
    roleLabel ? `Attorney for ${roleLabel}` : '',
    a.firm_name || '',
    ...String(a.firm_address || '').split('\n'),
    contact
  ].map(l => String(l == null ? '' : l).trim()).filter(Boolean);
}

// The stacked name lines at the top of a counsel block: the signing attorney
// first, then any additional counsel of record on the matter.
//
// Both halves of the role/office/address/contact block below are SHARED — the
// filed example stacks two names above one office line, it does not repeat the
// firm per attorney. Additional counsel therefore contribute a name line only.
//
// De-duplicated against the signing attorney by id AND by name: the signing
// attorney is picked per document while the list is stored on the matter, so
// the same person is very easily in both, and printing them twice in a filed
// caption is the kind of self-contradiction this app exists to remove.
//
// Mirrored by counselNameLines() in main.js.
function counselNameLines(attorney, coCounsel) {
  const a = attorney || {};
  const nameOf = (x) => [x.name, x.bar_number ? `(${x.bar_number})` : ''].filter(Boolean).join(' ');
  const primary = nameOf(a);
  const seenNames = new Set([String(a.name || '').trim().toLowerCase()].filter(Boolean));
  const extras = [];
  (Array.isArray(coCounsel) ? coCounsel : []).forEach((c) => {
    if (!c) return;
    if (a.id != null && c.id != null && c.id === a.id) return;
    const key = String(c.name || '').trim().toLowerCase();
    if (!key || seenNames.has(key)) return;
    seenNames.add(key);
    extras.push(nameOf(c));
  });
  return [primary, ...extras].filter(Boolean);
}

// ---- Blank-form blocks -----------------------------------------------------
// Mirrored by BLANK_RULE / formFieldText() and the form_* branches in main.js.
// The .docx is what actually gets printed; this is the preview of the same
// thing, and the two must ask the same question in the same words.
// 76, not 78 — see the comment on this same constant in main.js: 78 underscores
// exactly fill the 6.5" line with zero margin, and a wide-capitals label like
// "CDL Number" measured past that and wrapped. 76 leaves ~12pt of margin.
const BLANK_RULE = '_'.repeat(76);

function formFieldText(block) {
  const label = String(block.label || '');
  const kind = block.kind || 'text';
  if (kind === 'checkbox') return `${label}:   Yes [   ]    No [   ]`;
  if (kind === 'select') {
    const opts = (block.options || []).map(o => `${o} [   ]`).join('    ');
    return `${label}:   ${opts}`;
  }
  const room = Math.max(20, 76 - (label.length + 2));
  return `${label}: ${'_'.repeat(room)}`;
}

function renderFormField(block) {
  const first = `<div class="form-field">${esc(formFieldText(block))}</div>`;
  // A free-text answer needs more than one line to write on.
  return block.kind === 'textarea'
    ? first + `<div class="form-field">${esc(BLANK_RULE)}</div>`
    : first;
}

function renderFormTable(headings, rows) {
  const cols = (headings || []).map(h => `<th>${esc(h)}</th>`).join('');
  const blank = (headings || []).map(() => '<td>&nbsp;</td>').join('');
  const body = Array.from({ length: Math.max(1, rows || 1) }, () => `<tr>${blank}</tr>`).join('');
  return `<table class="form-table"><thead><tr>${cols}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---- The intake questionnaire's field list ---------------------------------
//
// ONE ordered list, read by two things that must never disagree: the profile
// form in renderer.js (which builds its `people` column list, its checkbox set
// and its "does this section hold answers" logic from it) and the printable
// blank questionnaire below. The attorney's intake runs two ways — typed live during a
// consultation, and on paper for a walk-in — and if the paper form is a second
// hand-maintained list it will quietly fall a year behind the screen, so staff
// collect answers with nowhere to put them.
//
//   section — the profile section the field lives in, in screen order
//   label   — the exact label the screen shows; also what prints on paper,
//             which is what makes the smoke test's drift guard possible
//   col     — the `people` column; the input's id is 'per-' + col
//   kind    — text | date | select | textarea | checkbox, i.e. how it is
//             answered, which is what the paper form has to know to leave the
//             right kind of blank
//   paper   — false ONLY for a field that is deliberately not on the paper
//             form. Exactly one field carries it (the superseded single-box
//             address), and the smoke test asserts that the excluded set is
//             exactly that one, so this cannot become an escape hatch for
//             skipping a field someone did not feel like laying out.
//   office  — true for the Organization block only: office configuration
//             (caption name, signing profile, usual side), saved with the
//             profile but never printed on the client's paper form.
const INTAKE_FIELDS = [
  { section: 'Identity & Contact', label: 'Name', col: 'display_name', kind: 'text' },
  { section: 'Identity & Contact', label: 'Type', col: 'kind', kind: 'select',
    options: ['Individual', 'Organization'] },
  // Shown on screen only when Type is Organization, directly under Type. Each
  // one only pre-fills a new case, which can override it. `office` keeps them
  // off the paper form: they describe how the office captions and signs this
  // client's cases, which is not something a walk-in answers. The smoke test
  // pins `office` to exactly these three columns in exactly this section.
  { section: 'Organization', label: 'Name in captions', col: 'caption_name', kind: 'text', office: true },
  { section: 'Organization', label: 'Signs as', col: 'signing_attorney_id', kind: 'select', office: true },
  { section: 'Organization', label: 'Usually', col: 'usual_role', kind: 'select',
    options: ['Plaintiff', 'Defendant'], office: true },
  { section: 'Identity & Contact', label: 'Firm / Organization', col: 'firm_name', kind: 'text' },
  { section: 'Identity & Contact', label: 'Date of Birth', col: 'dob', kind: 'date' },
  { section: 'Identity & Contact', label: 'Intake Date', col: 'intake_date', kind: 'date' },
  { section: 'Identity & Contact', label: 'Street', col: 'street', kind: 'text' },
  { section: 'Identity & Contact', label: 'City', col: 'city', kind: 'text' },
  { section: 'Identity & Contact', label: 'ZIP', col: 'zip', kind: 'text' },
  { section: 'Identity & Contact', label: 'Cell Phone', col: 'cell_phone', kind: 'text' },
  { section: 'Identity & Contact', label: 'Home Phone', col: 'home_phone', kind: 'text' },
  { section: 'Identity & Contact', label: 'Other Phone', col: 'phone', kind: 'text' },
  { section: 'Identity & Contact', label: 'Email', col: 'email', kind: 'text' },

  { section: 'Personal & Employment', label: 'Marital Status', col: 'marital_status', kind: 'text' },
  { section: 'Personal & Employment', label: 'Citizenship', col: 'citizenship', kind: 'text' },
  { section: 'Personal & Employment', label: 'Employer', col: 'employer', kind: 'text' },
  { section: 'Personal & Employment', label: 'Occupation', col: 'occupation', kind: 'text' },

  // Each endorsement is a yes/no AND a number. On screen the number box is
  // revealed by the tick; on paper both are always printed, because a walk-in
  // filling this in has no way to make a box appear.
  { section: 'Licenses', label: "Driver's License Number", col: 'license_number', kind: 'text' },
  { section: 'Licenses', label: 'CDL', col: 'cdl_license', kind: 'checkbox' },
  { section: 'Licenses', label: 'CDL Number', col: 'cdl_number', kind: 'text' },
  { section: 'Licenses', label: 'Chauffeur License', col: 'chauffeur_license', kind: 'checkbox' },
  { section: 'Licenses', label: 'Chauffeur Number', col: 'chauffeur_number', kind: 'text' },
  { section: 'Licenses', label: 'CPL (concealed pistol)', col: 'cpl_license', kind: 'checkbox' },
  { section: 'Licenses', label: 'CPL Number', col: 'cpl_number', kind: 'text' },

  { section: 'Emergency Contact', label: 'Emergency Contact Name', col: 'emergency_contact_name', kind: 'text' },
  { section: 'Emergency Contact', label: 'Relationship', col: 'emergency_contact_relationship', kind: 'text' },
  { section: 'Emergency Contact', label: 'Emergency Contact Phone', col: 'emergency_contact_phone', kind: 'text' },

  { section: 'Medical', label: 'Medical Issues', col: 'medical_issues', kind: 'textarea' },
  { section: 'Medical', label: 'Medications', col: 'medications', kind: 'textarea' },
  { section: 'Medical', label: 'Medical Marijuana Card', col: 'medical_marijuana_card', kind: 'checkbox' },

  { section: 'Education', label: 'College', col: 'education_college', kind: 'text' },
  { section: 'Education', label: 'High School', col: 'education_high_school', kind: 'text' },
  { section: 'Education', label: 'Highest Grade Completed', col: 'education_highest_grade', kind: 'text' },

  { section: 'Notes', label: 'Notes', col: 'notes', kind: 'textarea' },
  // Superseded by Street / City / ZIP above and kept only as the fallback for
  // rows migration 24 could not parse. It is still saved by the form, so it
  // belongs in this list; it is not asked for on paper.
  { section: 'Notes', label: 'Address (older single-box form — superseded by Street / City / ZIP above)',
    col: 'address', kind: 'textarea', paper: false }
];

// The prior-record table's columns, in print order — the same five the
// repeating table on screen renders, for the same reason the field list above
// is shared. renderer.js merges its own layout hints onto these.
const INTAKE_PRIOR_COLUMNS = [
  { col: 'offense', label: 'Offense' },
  { col: 'jurisdiction', label: 'Court' },
  { col: 'offense_date', label: 'Date' },
  { col: 'location', label: 'Place' },
  { col: 'disposition', label: 'Disposition' }
];

// A client can easily have five priors; fewer rows than that and staff write
// up the margin.
const INTAKE_PRIOR_ROWS = 5;

window.INTAKE_FIELDS = INTAKE_FIELDS;
window.INTAKE_PRIOR_COLUMNS = INTAKE_PRIOR_COLUMNS;

// The printable blank questionnaire, built from the list above and nothing
// else. Section headings come from the fields' own `section` values in order,
// so a new section appears on paper the moment it appears on screen.
window.DocumentEngine.buildIntakeQuestionnaire = function buildIntakeQuestionnaire(hasLetterhead) {
  const blocks = [];
  if (hasLetterhead) blocks.push({ type: 'letterhead' });
  blocks.push({ type: 'title_underlined', text: 'CLIENT INTAKE QUESTIONNAIRE' });
  blocks.push({ type: 'plain', text: 'Please print. Leave anything you are unsure of blank and we will finish it together.' });

  let currentSection = null;
  INTAKE_FIELDS.forEach(f => {
    if (f.paper === false || f.office) return;
    if (f.section !== currentSection) {
      currentSection = f.section;
      blocks.push({ type: 'form_section', text: currentSection });
    }
    blocks.push({ type: 'form_field', label: f.label, kind: f.kind, options: f.options });
  });

  // Prior Record owns no `people` column — it is a child table — so it is laid
  // out here rather than falling out of the field loop above.
  blocks.push({ type: 'form_section', text: 'Prior Record' });
  blocks.push({ type: 'plain', text: 'Prior Offenses — list every prior conviction. Continue on the back if you need more room.' });
  blocks.push({
    type: 'form_table',
    headings: INTAKE_PRIOR_COLUMNS.map(c => c.label),
    rows: INTAKE_PRIOR_ROWS
  });
  return blocks;
};
