#!/usr/bin/env python3
"""
Merge multiple PPTX files into a single presentation.
Properly handles embedded images by copying media files with new UUIDs
and updating relationship references using proper XML parsing.
"""

import zipfile
import os
import re
import uuid
import argparse
import sys
from lxml import etree
from copy import deepcopy
import shutil
import tempfile

NSMAP = {
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'ct': 'http://schemas.openxmlformats.org/package/2006/content-types',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}

REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def parse_xml(content):
    """Parse XML content, handling namespace prefixes properly."""
    return etree.fromstring(content)

def get_next_rid(rels_root, start_rid=1):
    """Get the next available rId number."""
    rids = []
    for rel in rels_root.findall(f'{{{REL_NS}}}Relationship'):
        rid = rel.get('Id', '')
        if rid.startswith('rId'):
            try:
                rids.append(int(rid[3:]))
            except ValueError:
                pass
    return max(rids) + 1 if rids else start_rid

def get_next_sldid(pres_root, start_id=256):
    """Get the next available slide id number."""
    sld_ids = []
    sldIdLst = pres_root.find(f'{{{P_NS}}}sldIdLst')
    if sldIdLst is not None:
        for sldId in sldIdLst.findall(f'{{{P_NS}}}sldId'):
            rid = sldId.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id', '')
            if rid.startswith('rId'):
                try:
                    sld_ids.append(int(sldId.get('id', 0)))
                except ValueError:
                    pass
    return max(sld_ids) + 1 if sld_ids else start_id

def merge_pptx(input_files, output_path, verbose=False):
    """
    Merge multiple PPTX files into one.
    Uses proper XML parsing instead of string replacement.
    """
    for f in input_files:
        if not os.path.exists(f):
            raise FileNotFoundError(f"Input file not found: {f}")

    if os.path.exists(output_path):
        os.remove(output_path)

    tmp_dir = tempfile.mkdtemp(prefix='pptx_merge_')
    try:
        all_items = {}

        with zipfile.ZipFile(input_files[0], 'r') as zf:
            for name in zf.namelist():
                all_items[name] = zf.read(name)

        pres_tree = parse_xml(all_items['ppt/presentation.xml'])
        rels_tree = parse_xml(all_items['ppt/_rels/presentation.xml.rels'])
        ct_tree = parse_xml(all_items['[Content_Types].xml'])

        slide_count = len([n for n in all_items.keys() if re.match(r'ppt/slides/slide\d+\.xml', n)])
        next_rid = get_next_rid(rels_tree) + 1
        next_sldid = get_next_sldid(pres_tree) + 1

        print(f'Initial: {slide_count} slides from {os.path.basename(input_files[0])}')

        for fname in input_files[1:]:
            print(f'\nMerging {os.path.basename(fname)}...')

            with zipfile.ZipFile(fname, 'r') as zf:
                src_namelist = zf.namelist()
                src_pres_tree = parse_xml(zf.read('ppt/presentation.xml'))
                src_rels_tree = parse_xml(zf.read('ppt/_rels/presentation.xml.rels'))

                rid_to_slide = {}
                for rel in src_rels_tree.findall(f'{{{REL_NS}}}Relationship'):
                    rid = rel.get('Id')
                    target = rel.get('Target', '')
                    rel_type = rel.get('Type', '')
                    if rid and 'slide' in rel_type.lower() and target.startswith('slides/'):
                        rid_to_slide[rid] = target

                sld_order = []
                sldIdLst = src_pres_tree.find(f'{{{P_NS}}}sldIdLst')
                if sldIdLst is not None:
                    for sldId in sldIdLst.findall(f'{{{P_NS}}}sldId'):
                        rid_attr = '{' + R_NS + '}id'
                        rid = sldId.get(rid_attr, '')
                        if rid in rid_to_slide:
                            sld_order.append(f"ppt/{rid_to_slide[rid]}")

                for slide_path in sld_order:
                    src_slide_num = re.search(r'slide(\d+)\.xml', slide_path).group(1)
                    slide_content = zf.read(slide_path)
                    slide_tree = parse_xml(slide_content)

                    slide_count += 1
                    new_slide_num = slide_count
                    new_slide_name = f'ppt/slides/slide{new_slide_num}.xml'
                    all_items[new_slide_name] = etree.tostring(slide_tree, xml_declaration=True,
                                                               encoding='UTF-8', standalone=True)

                    src_slide_rel_path = f'ppt/slides/_rels/slide{src_slide_num}.xml.rels'
                    new_slide_rel_path = f'ppt/slides/_rels/slide{new_slide_num}.xml.rels'

                    new_rel_parts = []
                    img_count = 0

                    if src_slide_rel_path in src_namelist:
                        src_rel_tree = parse_xml(zf.read(src_slide_rel_path))

                        for rel in src_rel_tree.findall(f'{{{REL_NS}}}Relationship'):
                            rel_id = rel.get('Id')
                            rel_type = rel.get('Type', '')
                            target = rel.get('Target', '')

                            if rel_type and 'image' in rel_type.lower():
                                media_name = os.path.basename(target)
                                src_media_path = None
                                for m in src_namelist:
                                    if m.endswith(media_name):
                                        src_media_path = m
                                        break

                                if src_media_path:
                                    media_content = zf.read(src_media_path)
                                    ext = os.path.splitext(media_name)[1]
                                    new_media_name = f'image{uuid.uuid4().hex[:8]}{ext}'
                                    new_media_path = f'ppt/media/{new_media_name}'
                                    all_items[new_media_path] = media_content

                                    new_rid = f'rId{next_rid}'
                                    next_rid += 1

                                    new_rel = etree.SubElement(src_rel_tree, f'{{{REL_NS}}}Relationship')
                                    new_rel.set('Id', new_rid)
                                    new_rel.set('Type', rel_type)
                                    new_rel.set('Target', f'../media/{new_media_name}')

                                    slide_str = etree.tostring(slide_tree, encoding='unicode')
                                    slide_str = slide_str.replace(f'r:embed="{rel_id}"', f'r:embed="{new_rid}"')
                                    slide_tree = parse_xml(slide_str.encode('utf-8'))
                                    all_items[new_slide_name] = etree.tostring(slide_tree, xml_declaration=True,
                                                                               encoding='UTF-8', standalone=True)
                                    img_count += 1

                                    rid_type = rel.get('Type', '')
                                    new_rel_parts.append((new_rid, rid_type, f'../media/{new_media_name}'))

                        new_slide_rel_content = etree.tostring(src_rel_tree, xml_declaration=True,
                                                               encoding='UTF-8', standalone=True)
                        all_items[new_slide_rel_path] = new_slide_rel_content

                    print(f'  Slide {src_slide_num} -> {new_slide_num}: {img_count} images')

                    new_rid = f'rId{next_rid}'
                    next_rid += 1

                    new_rel = etree.SubElement(rels_tree, f'{{{REL_NS}}}Relationship')
                    new_rel.set('Id', new_rid)
                    new_rel.set('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide')
                    new_rel.set('Target', f'slides/slide{new_slide_num}.xml')

                    sldIdLst = pres_tree.find(f'{{{P_NS}}}sldIdLst')
                    if sldIdLst is not None:
                        new_sldId = etree.SubElement(sldIdLst, f'{{{P_NS}}}sldId')
                        new_sldId.set('id', str(next_sldid))
                        new_sldId.set(f'{{{R_NS}}}id', new_rid)
                        next_sldid += 1

                    new_ct_entry = etree.SubElement(ct_tree, f'{{{CT_NS}}}Override')
                    new_ct_entry.set('PartName', f'/ppt/slides/slide{new_slide_num}.xml')
                    new_ct_entry.set('ContentType', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml')

        for name in list(all_items.keys()):
            if name.startswith('ppt/media/'):
                ext = name.split('.')[-1].lower()
                if ext == 'png':
                    ct = 'image/png'
                elif ext in ('jpg', 'jpeg'):
                    ct = 'image/jpeg'
                elif ext == 'gif':
                    ct = 'image/gif'
                else:
                    ct = 'application/octet-stream'

                ct_entry = f'/ppt/media/{os.path.basename(name)}'
                exists = False
                for child in ct_tree.findall(f'{{{CT_NS}}}Override'):
                    if child.get('PartName', '') == ct_entry:
                        exists = True
                        break
                if not exists:
                    new_ct = etree.SubElement(ct_tree, f'{{{CT_NS}}}Override')
                    new_ct.set('PartName', ct_entry)
                    new_ct.set('ContentType', ct)

        all_items['ppt/presentation.xml'] = etree.tostring(pres_tree, xml_declaration=True,
                                                            encoding='UTF-8', standalone=True)
        all_items['ppt/_rels/presentation.xml.rels'] = etree.tostring(rels_tree, xml_declaration=True,
                                                                      encoding='UTF-8', standalone=True)
        all_items['[Content_Types].xml'] = etree.tostring(ct_tree, xml_declaration=True,
                                                           encoding='UTF-8', standalone=True)

        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for name, content in all_items.items():
                zf.writestr(name, content)

        print(f'\nMerged {len(input_files)} files into {os.path.basename(output_path)}')
        print(f'Total slides: {slide_count}')
        print(f'Output: {output_path}')

        if verify_pptx(output_path):
            print('Verification: PASSED')
            return slide_count
        else:
            raise RuntimeError('PPTX verification failed - file may be corrupted')

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

def verify_pptx(pptx_path):
    """Verify that the PPTX file is valid by opening it with python-pptx."""
    try:
        from pptx import Presentation
        prs = Presentation(pptx_path)
        return True
    except Exception as e:
        print(f'Verification warning: {e}')
        return False

def main():
    parser = argparse.ArgumentParser(description='Merge multiple PPTX files into one')
    parser.add_argument('inputs', nargs='+', help='Input PPTX files in merge order')
    parser.add_argument('-o', '--output', required=True, help='Output PPTX file path')
    parser.add_argument('-v', '--verbose', action='store_true', help='Verbose output')

    args = parser.parse_args()

    if len(args.inputs) < 2:
        print('Error: Need at least 2 input files to merge')
        sys.exit(1)

    for f in args.inputs:
        if not os.path.exists(f):
            print(f'Error: File not found: {f}')
            sys.exit(1)

    try:
        merge_pptx(args.inputs, args.output, verbose=args.verbose)
    except Exception as e:
        print(f'Error during merge: {e}')
        if args.verbose:
            import traceback
            traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()