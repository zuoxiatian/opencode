#!/usr/bin/env python3
"""
Merge multiple PPTX files into a single presentation.
Properly handles embedded images by copying media files with new UUIDs
and updating relationship references.
"""

import zipfile
import os
import re
import uuid
import argparse
import sys


def parse_rel(rel_str):
    """Parse a Relationship element regardless of attribute order"""
    id_m = re.search(r'Id="([^"]+)"', rel_str)
    type_m = re.search(r'Type="([^"]+)"', rel_str)
    target_m = re.search(r'Target="([^"]+)"', rel_str)
    if id_m and type_m and target_m:
        return id_m.group(1), type_m.group(1), target_m.group(1)
    return None, None, None


def merge_pptx(input_files, output_path):
    """
    Merge multiple PPTX files into one.
    Handles embedded images by copying media files with new UUIDs
    and updating relationship references.
    """
    if os.path.exists(output_path):
        os.remove(output_path)

    # Start with first file
    with zipfile.ZipFile(input_files[0], 'r') as zf:
        all_items = {name: zf.read(name) for name in zf.namelist()}

    pres_xml = all_items['ppt/presentation.xml'].decode('utf-8')
    rels_xml = all_items['ppt/_rels/presentation.xml.rels'].decode('utf-8')
    ct_xml = all_items['[Content_Types].xml'].decode('utf-8')

    rids = re.findall(r'Id="rId(\d+)"', rels_xml)
    max_rid = max(int(r) for r in rids) if rids else 0
    sld_ids = re.findall(r'<p:sldId id="(\d+)"', pres_xml)
    max_sld_id = max(int(s) for s in sld_ids) if sld_ids else 256
    new_slide_num = len([n for n in all_items.keys() if re.match(r'ppt/slides/slide\d+\.xml', n)])

    print(f'Initial: {new_slide_num} slides from {os.path.basename(input_files[0])}')

    for fname in input_files[1:]:
        src_path = fname
        print(f'\nMerging {os.path.basename(fname)}...')

        with zipfile.ZipFile(src_path, 'r') as zf:
            src_namelist = zf.namelist()
            src_slides = sorted([n for n in src_namelist if re.match(r'ppt/slides/slide\d+\.xml', n)])
            src_rels_xml = zf.read('ppt/_rels/presentation.xml.rels').decode('utf-8')

            for slide_name in src_slides:
                src_slide_num = re.search(r'slide(\d+)\.xml', slide_name).group(1)
                slide_content = zf.read(slide_name).decode('utf-8')

                new_slide_num += 1
                max_rid += 1
                max_sld_id += 1

                new_slide_name = f'ppt/slides/slide{new_slide_num}.xml'
                all_items[new_slide_name] = slide_content.encode('utf-8')

                src_slide_rel = f'ppt/slides/_rels/slide{src_slide_num}.xml.rels'
                new_slide_rel = f'ppt/slides/_rels/slide{new_slide_num}.xml.rels'

                new_rel_parts = []
                img_count = 0

                if src_slide_rel in src_namelist:
                    rels_content = zf.read(src_slide_rel).decode('utf-8')

                    for rel_match in re.finditer(r'<Relationship[^>]+/>', rels_content):
                        rel_str = rel_match.group(0)
                        rid, rel_type, target = parse_rel(rel_str)

                        if not rid:
                            continue

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

                                max_rid += 1
                                new_rid = f'rId{max_rid}'
                                rel_target = f'../media/{new_media_name}'
                                new_rel_parts.append(f'<Relationship Id="{new_rid}" Type="{rel_type}" Target="{rel_target}"/>')

                                slide_content = slide_content.replace(f'r:embed="{rid}"', f'r:embed="{new_rid}"')
                                all_items[new_slide_name] = slide_content.encode('utf-8')
                                img_count += 1

                print(f'  Slide {src_slide_num} -> {new_slide_num}: {img_count} images')

                new_slide_rel_content = '''<?xml version='1.0' encoding='UTF-8' standalone='yes'?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
'''
                new_slide_rel_content += '\n'.join(new_rel_parts)
                new_slide_rel_content += '\n</Relationships>'
                all_items[new_slide_rel] = new_slide_rel_content.encode('utf-8')

                new_rid = f'rId{max_rid}'
                rels_xml = rels_xml.replace('</Relationships>',
                    f'<Relationship Id="{new_rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{new_slide_num}.xml"/></Relationships>')

                new_sld_id = f'<p:sldId id="{max_sld_id}" r:id="{new_rid}"/>'
                pres_xml = re.sub(r'(<p:sldIdLst>)(.*?)(</p:sldIdLst>)',
                                 lambda m: f'<p:sldIdLst>{m.group(2)}{new_sld_id}</p:sldIdLst>',
                                 pres_xml, flags=re.DOTALL)

                ct_xml = ct_xml.replace('</Types>',
                    f'<Override PartName="/ppt/slides/slide{new_slide_num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>')

    # Update content types for media
    for name in all_items.keys():
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
            ct_entry = f'<Override PartName="/{name}" ContentType="{ct}"/>'
            if ct_entry not in ct_xml:
                ct_xml = ct_xml.replace('</Types>', f'{ct_entry}</Types>')

    all_items['ppt/presentation.xml'] = pres_xml.encode('utf-8')
    all_items['ppt/_rels/presentation.xml.rels'] = rels_xml.encode('utf-8')
    all_items['[Content_Types].xml'] = ct_xml.encode('utf-8')

    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, content in all_items.items():
            zf.writestr(name, content)

    print(f'\nMerged {len(input_files)} files into {os.path.basename(output_path)}')
    print(f'Total slides: {new_slide_num}')
    print(f'Output: {output_path}')
    return new_slide_num


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
        merge_pptx(args.inputs, args.output)
    except Exception as e:
        print(f'Error during merge: {e}')
        if args.verbose:
            import traceback
            traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()